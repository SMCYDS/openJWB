import base64
import json
import re
import secrets
import subprocess
import tempfile
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, quote, urljoin, urlsplit

import requests

try:
    from server.hls_monitor import HLSMonitor, MonitorPool, StreamAuthError
    from server.plugin_registry import load_plugin_upstreams
except ImportError:
    from hls_monitor import HLSMonitor, MonitorPool, StreamAuthError
    from plugin_registry import load_plugin_upstreams

try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

PUBLIC = Path(__file__).resolve().parent.parent / 'public'
UPSTREAMS = {'my': 'https://my.sjtu.edu.cn', 'jaccount': 'https://jaccount.sjtu.edu.cn', 'pe': 'https://pe.sjtu.edu.cn', 'oc': 'https://oc.sjtu.edu.cn', 'make': 'https://make.sjtu.edu.cn', 'calendar': 'https://calendar.sjtu.edu.cn', 'i': 'https://i.sjtu.edu.cn', 'activity': 'https://activity.sjtu.edu.cn', 'ids': 'https://ids.sjtu.edu.cn', 'live': 'https://v.sjtu.edu.cn'}
EXPOSED_COOKIES = {
    'my': {'JSESSIONID', 'JAAuthCookie'},
    'jaccount': {'JSESSIONID', 'JAAuthCookie'},
    'pe': {'JSESSIONID'},
    'oc': {'_normandy_session', '_legacy_normandy_session', 'log_session_id', '_csrf_token'},
    'calendar': {'JSESSIONID', 'PORTAL_LOCALE'},
    'i': {'JSESSIONID'},
    'ids': {'JSESSIONID'},
    'live': {'jy-application-resourcemanage'}
}
load_plugin_upstreams(PUBLIC / 'plugins', UPSTREAMS, EXPOSED_COOKIES)
ALLOWED_HOSTS = {urlsplit(origin).hostname for origin in UPSTREAMS.values()}
SESSION_TTL = 2 * 60 * 60
MAX_REDIRECTS = 10
MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def allowed_url(url):
    parsed = urlsplit(url)
    return (parsed.scheme == 'https' and parsed.hostname in ALLOWED_HOSTS
            and parsed.port in (None, 443) and not parsed.username and not parsed.password)


class BridgeSession:
    def __init__(self):
        # One upstream cookie jar per local browser session; cookies never move to document.cookie.
        self.http = requests.Session()
        self.http.headers['User-Agent'] = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                                           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
        self.last_used = time.monotonic()
        self.lock = threading.Lock()
        self.live_streams = MonitorPool()

    def request(self, service, path, method='GET', params=None, body=None, body_type='json', headers=None):
        if service not in UPSTREAMS or not isinstance(path, str):
            raise ValueError('请求目标不在允许范围内')
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc:
            if parsed.scheme != 'https' or parsed.netloc != urlsplit(UPSTREAMS[service]).netloc:
                raise ValueError('请求目标主机不匹配')
            path = parsed.path
            if parsed.query:
                query_params = dict(parse_qsl(parsed.query))
                if params is not None:
                    query_params.update(params)
                params = query_params
        elif parsed.query:
            path = parsed.path
            query_params = dict(parse_qsl(parsed.query))
            if params is not None:
                query_params.update(params)
            params = query_params
        if not path.startswith('/') or path.startswith('//') or parsed.fragment:
            raise ValueError('请求路径无效')
        if method not in ('GET', 'POST') or body_type not in ('json', 'form'):
            raise ValueError('请求方法或格式无效')
        if params is not None and (not isinstance(params, dict) or
                                   any(not isinstance(k, str) or not isinstance(v, (str, int)) for k, v in params.items())):
            raise ValueError('查询参数无效')
        if body is not None and (method != 'POST' or (not isinstance(body, dict) if body_type == 'form' else not isinstance(body, (dict, list)))):
            raise ValueError('请求内容无效')
        if headers is not None:
            if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
                raise ValueError('请求头无效')
        url = urljoin(UPSTREAMS[service], path)
        with self.lock:
            for _ in range(MAX_REDIRECTS + 1):
                # Validate every redirect, not just the first URL, to avoid an open proxy.
                if not allowed_url(url):
                    raise ValueError('跳转目标不在允许范围内')
                options = {'params': params, 'timeout': 15, 'allow_redirects': False, 'stream': True}
                if headers is not None:
                    options['headers'] = dict(headers)
                if body is not None:
                    options['json' if body_type == 'json' else 'data'] = body
                response = self.http.request(method, url, **options)
                try:
                    if response.status_code not in (301, 302, 303, 307, 308) or not response.headers.get('Location'):
                        chunks, size = [], 0
                        for chunk in response.iter_content(64 * 1024):
                            size += len(chunk)
                            if size > MAX_RESPONSE_BYTES:
                                raise ValueError('上游响应过大')
                            chunks.append(chunk)
                        return response.status_code, response.headers.get('Content-Type', 'application/octet-stream'), b''.join(chunks), response.url
                    next_url = urljoin(response.url, response.headers['Location'])
                    # 白名单主机的 http 跳转统一升级为 https（如 i.sjtu.edu.cn 的 oauth 回调），避免明文携带 code
                    parsed_next = urlsplit(next_url)
                    if parsed_next.scheme == 'http' and parsed_next.hostname in ALLOWED_HOSTS:
                        next_url = parsed_next._replace(scheme='https').geturl()
                    if headers is not None and urlsplit(next_url).netloc != urlsplit(url).netloc:
                        headers = {k: v for k, v in headers.items() if k.lower() not in ('authorization', 'jwt-token')}
                    url = next_url
                    if response.status_code in (301, 302, 303) and method == 'POST':
                        method, body = 'GET', None
                    params = None
                finally:
                    response.close()
        raise ValueError('上游跳转次数过多')

    def set_cookie(self, domain_or_service, name, value):
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError('参数无效')
        if domain_or_service in UPSTREAMS:
            domain = urlsplit(UPSTREAMS[domain_or_service]).hostname
        elif domain_or_service in ('.sjtu.edu.cn', 'sjtu.edu.cn'):
            domain = '.sjtu.edu.cn'
        else:
            raise ValueError('目标域无效')
        with self.lock:
            self.http.cookies.set(name, value, domain=domain, path='/')

    def cookie(self, service, name):
        # Only the credential explicitly required by the frontend is readable by JS.
        if name not in EXPOSED_COOKIES.get(service, ()):
            raise ValueError('不允许读取该 Cookie')
        url = UPSTREAMS[service]
        with self.lock:
            header = requests.cookies.get_cookie_header(self.http.cookies, requests.Request('GET', url).prepare()) or ''
            cookies = SimpleCookie()
            cookies.load(header)
            if name in cookies:
                return cookies[name].value
            domain = urlsplit(url).hostname
            for c in self.http.cookies:
                if c.name == name and (c.domain == domain or c.domain == '.' + domain or domain.endswith(c.domain)):
                    return c.value
        return None

    def close(self):
        self.live_streams.close()
        self.http.close()


class SessionStore:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()

    def create(self, old_ids=None):
        session_id = secrets.token_urlsafe(32)
        if isinstance(old_ids, str):
            old_ids = [old_ids]
        elif old_ids is None:
            old_ids = []
        with self.lock:
            closed = []
            for oid in old_ids:
                previous = self.sessions.pop(oid, None)
                if previous:
                    closed.append(previous)
            self.sessions[session_id] = BridgeSession()
        for previous in closed:
            previous.close()
        return session_id

    def get(self, session_id):
        with self.lock:
            session = self.sessions.get(session_id)
            if session and time.monotonic() - session.last_used < SESSION_TTL:
                session.last_used = time.monotonic()
                return session
            expired = self.sessions.pop(session_id, None)
        if expired:
            expired.close()
        return None

    def cleanup(self):
        with self.lock:
            expired = [self.sessions.pop(key) for key, value in list(self.sessions.items())
                       if time.monotonic() - value.last_used >= SESSION_TTL]
        for session in expired:
            session.close()


store = SessionStore()


# 直播最新帧抓取（课件/电脑屏幕通道）：用 opencv 内置 ffmpeg 解码抽帧，
# Optional QRCodeDetector for QR codes in classroom frames.
LIVE_STREAM_HOST = 'mss2.sjtu.edu.cn'
# 对齐 HAR 中成功播放的请求头；播放鉴权使用课程接口实时返回的 auth_key 和 mainTokenStr。
STREAM_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) '
             'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1')
STREAM_REFERER = 'https://v.sjtu.edu.cn/'
STREAM_HEADERS = {'User-Agent': STREAM_UA, 'Referer': STREAM_REFERER, 'Accept': '*/*'}
# ffmpeg -headers 参数要求 CRLF 分隔的单字符串
STREAM_HEADERS_FFMPEG = ''.join(f'{k}: {v}\r\n' for k, v in STREAM_HEADERS.items())


class LiveAuthError(ValueError):
    """通知前端走现有登录重试流程，不复用失效的播放凭据。"""


class LiveCourseUnavailable(ValueError):
    """课次不在直播时间内，刷新认证不能恢复已结束的直播。"""


def live_course_view(session, course_id, jwt_token=None):
    headers = {'Cache-Control': 'no-cache'}
    if jwt_token:
        if not isinstance(jwt_token, str) or '\r' in jwt_token or '\n' in jwt_token:
            raise ValueError('JWT 格式无效')
        headers['Jwt-Token'] = jwt_token
    status, _, data, _ = session.request(
        'live', '/jy-application-resourcemanage/v1/course_vod_videoinfos',
        params={'courseId': str(course_id), 'playType': '3'},
        headers=headers)
    # 平台匿名访问受保护接口也可能返回 500（与 fetchUser 的处理保持一致）。
    if status in (401, 403, 500):
        raise LiveAuthError('课堂实录认证已失效，请重新登录后获取直播画面')
    if status != 200:
        raise ValueError(f'课程信息获取失败 ({status})')
    try:
        result = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise LiveAuthError('课程接口未返回 JSON，请重新登录课堂实录')
    if result.get('code') in (401, 403, '401', '403'):
        raise LiveAuthError('课堂实录认证已失效，请重新登录后获取直播画面')
    if result.get('ok') is False or result.get('dataOk') is False:
        raise ValueError('课程信息获取失败：' + str(result.get('message') or '上游业务错误'))
    info = result.get('data') or {}
    # 以 API 的当前时间比较，避免客户端时钟偏差；旧课次仍可能返回已过期的直播 URL。
    now = float(result.get('timestamp') or time.time() * 1000)
    end = info.get('liveEndTime') or info.get('courEndTime')
    start = info.get('liveStartTime') or info.get('courBeginTime')
    if end and now >= float(end):
        raise LiveCourseUnavailable(f'courseId={course_id} 的直播已结束，请查询今日直播课程并填写当前课次的 courseId')
    if start and now < float(start):
        raise LiveCourseUnavailable(f'courseId={course_id} 的直播尚未开始，请在开播后重试')
    view = select_courseware_view(info)
    if not view or not view.get('chanNameMainPlayUrl'):
        raise ValueError('该课程没有可用的课件直播通道（可能未开播）')
    return info, view


def live_stream_url(view):
    url = view['chanNameMainPlayUrl']
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != LIVE_STREAM_HOST
            or parsed.port not in (None, 443) or parsed.username or parsed.password):
        raise ValueError('直播流地址不在允许范围内')
    token = view.get('mainTokenStr')
    if token:
        # 保留 auth_key 原始签名；替换已有 token，避免重复或 base64 的 + 被当成空格。
        query = '&'.join(part for part in parsed.query.split('&')
                         if part and part.split('=', 1)[0] != 'account_token')
        query += ('&' if query else '') + 'account_token=' + quote(token, safe='')
        url = parsed._replace(query=query, fragment='').geturl()
    return url


def fetch_latest_segment(m3u8_url, depth=0):
    # 下载 m3u8 playlist，取最新（最后一个）ts 分片字节。
    # HLS 直播为滑动窗口，最后一个分片即直播最新时刻；
    # 分片 URL 一般已带 CDN 鉴权签名（auth_key），保持原样用 urljoin 还原。
    if depth > 4:
        raise ValueError('直播 playlist 嵌套过深')
    parsed = urlsplit(m3u8_url)
    if parsed.scheme != 'https' or parsed.hostname != LIVE_STREAM_HOST or parsed.port not in (None, 443):
        raise ValueError('直播 playlist 地址不在允许范围内')
    response = requests.get(m3u8_url, headers=STREAM_HEADERS, timeout=10, allow_redirects=False)
    if response.status_code in (401, 403):
        raise LiveAuthError('直播流鉴权失败，请重新认证并获取新的播放凭据')
    response.raise_for_status()
    if response.is_redirect:
        raise ValueError('直播 playlist 返回了意外跳转')
    lines = [line.strip() for line in response.text.splitlines()
             if line.strip() and not line.startswith('#')]
    if not lines:
        raise ValueError('直播 playlist 为空')
    last = lines[-1]
    if urlsplit(last).path.endswith('.m3u8'):
        # master playlist：先进入最后一个变体子 playlist
        return fetch_latest_segment(urljoin(m3u8_url, last), depth + 1)
    seg_url = urljoin(m3u8_url, last)
    parsed = urlsplit(seg_url)
    if parsed.scheme != 'https' or parsed.hostname != LIVE_STREAM_HOST or parsed.port not in (None, 443):
        raise ValueError('分片地址不在允许范围内')
    seg = requests.get(seg_url, headers=STREAM_HEADERS, timeout=10, allow_redirects=False)
    if seg.status_code in (401, 403):
        raise LiveAuthError('直播分片鉴权失败，请重新认证并获取新的播放凭据')
    seg.raise_for_status()
    if seg.is_redirect:
        raise ValueError('直播分片返回了意外跳转')
    return seg.content


def ffmpeg_pipe(args, timeout=40):
    # 用 imageio-ffmpeg 提供的完整 ffmpeg（含 HLS/HEVC 解码，优于 opencv 精简 ffmpeg）
    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run([exe, '-hide_banner', '-loglevel', 'error'] + args,
                            capture_output=True, timeout=timeout)
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode('utf-8', 'replace')
        if re.search(r'\b(?:401 Unauthorized|403 Forbidden)\b', detail):
            raise LiveAuthError('直播流鉴权失败，请重新认证并获取新的播放凭据')
        raise ValueError(re.sub(r'https?://\S+', '[stream]', detail)[:300] or 'ffmpeg 无输出')
    return result.stdout


def ffmpeg_grab_live(m3u8_url):
    # live_start_index=-1：从最新分片起解码，第一帧即直播最新画面；
    # -headers 注入 Referer/UA，否则 mss2 CDN 返回 403
    return ffmpeg_pipe(['-headers', STREAM_HEADERS_FFMPEG,
                        '-live_start_index', '-1', '-i', m3u8_url,
                        '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'])


def ffmpeg_grab_segment(ts_bytes):
    # TS 分片通常不能可靠地按文件结尾 seek；完整解码短分片，再取最后一帧。
    with tempfile.NamedTemporaryFile(suffix='.ts', delete=False) as tmp:
        tmp.write(ts_bytes)
        path = tmp.name
    try:
        return ffmpeg_pipe(['-i', path, '-vf', 'reverse',
                            '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'])
    finally:
        Path(path).unlink(missing_ok=True)


def grab_live_frame(m3u8_url, detect_qr=True, read_frames=4):
    if urlsplit(m3u8_url).hostname != LIVE_STREAM_HOST:
        raise ValueError('直播流地址不在允许范围内')
    try:
        import cv2
        import numpy as np
    except ImportError:
        raise ValueError('服务端未安装 opencv-python，无法抓取直播帧')
    jpeg = None
    errors = []
    # 先用 HTTP 读取最新分片，鉴权失败立即交给前端登录重试，避免对失效 URL 连续抽帧。
    try:
        jpeg = ffmpeg_grab_segment(fetch_latest_segment(m3u8_url))
    except LiveAuthError:
        raise
    except Exception as error:
        errors.append('分片:' + re.sub(r'https?://\S+', '[stream]', str(error))[:160])
    # 分片解码失败时回退完整 HLS 解码（例如需要跨分片的解码信息）。
    if jpeg is None:
        try:
            jpeg = ffmpeg_grab_live(m3u8_url)
        except LiveAuthError:
            raise
        except Exception as error:
            errors.append('HLS:' + re.sub(r'https?://\S+', '[stream]', str(error))[:160])
    if jpeg is None:
        detail = '; '.join(e.replace(m3u8_url, '[stream]') for e in errors)
        raise ValueError(f'未读取到直播画面（{detail}）')
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError('画面解码失败')
    qr_text = None
    if detect_qr:
        detector = cv2.QRCodeDetector()
        text, _, _ = detector.detectAndDecode(frame)
        if text:
            qr_text = text
        else:
            ok, texts, _, _ = detector.detectAndDecodeMulti(frame)
            if ok and texts:
                qr_text = next((t for t in texts if t), None)
    return base64.b64encode(jpeg).decode('ascii'), qr_text


def select_courseware_view(course_info):
    # 选课课件（电脑屏幕）通道而非教师摄像头：优先通道名含“课件”的设备
    views = course_info.get('courseDeviceViewDtoList') or []
    for view in views:
        if '课件' in (view.get('chanNameMain') or ''):
            return view
    return views[-1] if views else None


class RequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, format, *args):
        pass

    def respond(self, status, body, cookie=None):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        if cookie:
            if isinstance(cookie, (list, tuple)):
                for c in cookie:
                    self.send_header('Set-Cookie', c)
            else:
                self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(data)

    def session_ids(self):
        header = self.headers.get('Cookie', '')
        return re.findall(r'(?:^|;\s*)openjwb_session=([^;]+)', header)

    def get_session(self):
        for sid in self.session_ids():
            session = store.get(sid)
            if session:
                return sid, session
        return None, None

    def do_POST(self):
        host = self.headers.get('Host', '')
        if host not in (f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'):
            return self.respond(HTTPStatus.FORBIDDEN, {'ok': False, 'message': '非法主机'})
        if self.headers.get('Origin') not in (None, 'http://' + host):
            return self.respond(HTTPStatus.FORBIDDEN, {'ok': False, 'message': '非法来源'})
        if self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin', 'none'):
            return self.respond(HTTPStatus.FORBIDDEN, {'ok': False, 'message': '非法来源'})
        if self.headers.get('Content-Type', '').split(';')[0].lower() != 'application/json':
            return self.respond(HTTPStatus.BAD_REQUEST, {'ok': False, 'message': '需要 JSON 请求'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise ValueError('请求长度无效')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('请求内容无效')
            if self.path == '/api/bridge/session':
                session_id = store.create(self.session_ids())
                cookies = [
                    'openjwb_session=' + session_id + '; HttpOnly; SameSite=Lax; Path=/api/bridge',
                    'openjwb_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/api',
                    'openjwb_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/'
                ]
                return self.respond(HTTPStatus.OK, {'ok': True}, cookies)
            _, session = self.get_session()
            if not session:
                return self.respond(HTTPStatus.UNAUTHORIZED, {'ok': False, 'message': '会话已过期'})
            if self.path == '/api/bridge/live/watch':
                # Application adapter only: authentication/course resolution stays here.
                # The independent worker receives only a signed HLS URL and HTTP headers.
                action = payload.get('action')
                if action == 'start':
                    course_id = payload.get('courseId')
                    if not isinstance(course_id, (int, str)) or not str(course_id).isdigit():
                        raise ValueError('courseId 无效')
                    info, view = live_course_view(session, course_id, payload.get('jwtToken'))
                    stream_url = live_stream_url(view)
                    detect_qr = payload.get('detectQr', True) is not False
                    end = info.get('liveEndTime') or info.get('courEndTime')
                    lifetime = max(1, float(end) / 1000 - time.time()) if end else None
                    token = session.live_streams.acquire(
                        (str(course_id), detect_qr),
                        lambda: HLSMonitor(stream_url, STREAM_HEADERS, {LIVE_STREAM_HOST},
                                           detect_qr=detect_qr, lifetime=lifetime),
                        {'channel': view.get('chanNameMain'), 'courseName': info.get('courName')})
                    return self.respond(HTTPStatus.OK, {'ok': True, 'watchId': token})
                if action == 'stop':
                    session.live_streams.release(str(payload.get('watchId', '')))
                    return self.respond(HTTPStatus.OK, {'ok': True})
                if action == 'next':
                    after = payload.get('after', 0)
                    if not isinstance(after, int) or after < 0:
                        raise ValueError('帧游标无效')
                    try:
                        event = session.live_streams.next(str(payload.get('watchId', '')), after)
                    except StreamAuthError:
                        raise LiveAuthError('直播流鉴权已失效，正在重新获取播放凭据') from None
                    except EOFError:
                        return self.respond(HTTPStatus.OK, {'ok': True, 'ended': True})
                    return self.respond(HTTPStatus.OK, {'ok': True, 'event': event})
                raise ValueError('直播监听操作无效')
            if self.path == '/api/bridge/live/frame':
                # 获取直播最新帧（课件通道）：会话内取课程信息 -> 课件 m3u8 -> cv2 抽帧/识码
                course_id = payload.get('courseId')
                if course_id is None:
                    raise ValueError('缺少 courseId')
                info, view = live_course_view(session, course_id, payload.get('jwtToken'))
                m3u8 = live_stream_url(view)
                frame, qr_text = grab_live_frame(m3u8, detect_qr=payload.get('detectQr', True))
                return self.respond(HTTPStatus.OK, {
                    'ok': True, 'frame': frame, 'qrText': qr_text,
                    'channel': view.get('chanNameMain'), 'courseName': info.get('courName')
                })
            if self.path == '/api/bridge/request':
                status, content_type, data, final_url = session.request(
                                                             payload.get('service'), payload.get('path'),
                                                             payload.get('method', 'GET'), payload.get('params'),
                                                             payload.get('body'), payload.get('bodyType', 'json'),
                                                             payload.get('headers'))
                return self.respond(HTTPStatus.OK, {
                    'ok': True, 'status': status, 'contentType': content_type, 'url': final_url,
                    'data': base64.b64encode(data).decode('ascii')
                })
            if self.path == '/api/bridge/cookie':
                return self.respond(HTTPStatus.OK, {'ok': True, 'value': session.cookie(
                    payload.get('service'), payload.get('name'))})
            if self.path == '/api/bridge/cookie/set':
                session.set_cookie(payload.get('service'), payload.get('name'), payload.get('value'))
                return self.respond(HTTPStatus.OK, {'ok': True})
        except LiveCourseUnavailable as error:
            return self.respond(HTTPStatus.CONFLICT, {
                'ok': False, 'courseUnavailable': True, 'message': str(error)})
        except LiveAuthError as error:
            return self.respond(HTTPStatus.UNAUTHORIZED, {
                'ok': False, 'authInvalid': True, 'message': str(error)})
        except (ValueError, TypeError, OverflowError) as error:
            return self.respond(HTTPStatus.BAD_REQUEST, {'ok': False, 'message': str(error)})
        except requests.RequestException:
            return self.respond(HTTPStatus.BAD_GATEWAY, {'ok': False, 'message': '上游请求失败'})
        self.respond(HTTPStatus.NOT_FOUND, {'ok': False, 'message': '未找到接口'})

    def end_headers(self):
        if self.command == 'GET':
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self.respond(HTTPStatus.NOT_FOUND, {'ok': False, 'message': '未找到接口'})
        if self.path == '/':
            self.path = '/index.html'
        super().do_GET()


def cleanup_sessions():
    while True:
        time.sleep(60)
        store.cleanup()


if __name__ == '__main__':
    threading.Thread(target=cleanup_sessions, daemon=True).start()
    print('openJWB running at http://127.0.0.1:51896')
    ThreadingHTTPServer(('127.0.0.1', 51896), RequestHandler).serve_forever()
