"""离线验证直播凭据更新和 HTTP/ffmpeg 鉴权错误的传递。"""
import importlib.util
import io
import json
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    'bridge', Path(__file__).resolve().parents[1] / 'server/requestHandler.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class LiveFrameTests(unittest.TestCase):
    def test_watch_adapter_resolves_credentials_and_releases_lease(self):
        session = bridge.BridgeSession()
        worker = Mock(stopped=threading.Event())
        worker.start.return_value = worker
        worker.next.return_value = {'eventId': 1, 'frame': 'jpeg', 'qrText': 'decoded-qr'}

        def call(payload):
            handler = object.__new__(bridge.RequestHandler)
            body = json.dumps(payload).encode()
            handler.path = '/api/bridge/live/watch'
            handler.server = SimpleNamespace(server_port=51896)
            handler.headers = {'Host': '127.0.0.1:51896', 'Content-Type': 'application/json',
                               'Content-Length': str(len(body))}
            handler.rfile = io.BytesIO(body)
            handler.get_session = Mock(return_value=('session', session))
            handler.respond = Mock()
            handler.do_POST()
            status, result = handler.respond.call_args.args
            self.assertEqual(status, 200)
            return result

        view = {'chanNameMainPlayUrl': 'https://mss2.sjtu.edu.cn/live/a.m3u8',
                'mainTokenStr': 'fresh-stream-token', 'chanNameMain': '课件'}
        try:
            with patch.object(bridge, 'live_course_view', return_value=(
                    {'courName': '课程', 'liveEndTime': (time.time() + 60) * 1000}, view)) as lookup, \
                    patch.object(bridge, 'HLSMonitor', return_value=worker) as create:
                watch_id = call({'action': 'start', 'courseId': 123, 'jwtToken': 'app-jwt'})['watchId']
                lookup.assert_called_once_with(session, 123, 'app-jwt')
                headers = create.call_args.args[1]
                self.assertNotIn('Jwt-Token', headers)
                self.assertNotIn('Cookie', headers)
                event = call({'action': 'next', 'watchId': watch_id, 'after': 0})['event']
                self.assertEqual(event['qrText'], 'decoded-qr')
                self.assertEqual(event['courseName'], '课程')
                call({'action': 'stop', 'watchId': watch_id})
                worker.close.assert_called_once()
        finally:
            session.close()

    def test_course_request_includes_jwt(self):
        session = Mock()
        session.request.return_value = (200, '', b'{"data":{}}', '')
        with self.assertRaises(ValueError):
            bridge.live_course_view(session, 123, 'fresh-jwt')
        self.assertEqual(session.request.call_args.kwargs['headers']['Jwt-Token'], 'fresh-jwt')

    def test_course_time_uses_upstream_clock(self):
        for now, expected in [(2000, '已结束'), (500, '尚未开始')]:
            session = Mock()
            session.request.return_value = (200, '', json.dumps({
                'timestamp': now, 'data': {'liveStartTime': 1000, 'liveEndTime': 2000}
            }).encode(), '')
            with self.subTest(now=now), self.assertRaisesRegex(bridge.LiveCourseUnavailable, expected):
                bridge.live_course_view(session, 123)

    def test_old_course_endpoint_does_not_attempt_stream_or_login(self):
        handler = object.__new__(bridge.RequestHandler)
        body = b'{"courseId":123}'
        handler.path = '/api/bridge/live/frame'
        handler.server = SimpleNamespace(server_port=51896)
        handler.headers = {'Host': '127.0.0.1:51896', 'Content-Type': 'application/json',
                           'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.get_session = Mock(return_value=('session', Mock()))
        handler.respond = Mock()
        with patch.object(bridge, 'live_course_view', side_effect=bridge.LiveCourseUnavailable('已结束')), \
                patch.object(bridge, 'grab_live_frame') as grab:
            handler.do_POST()
        status, result = handler.respond.call_args.args
        self.assertEqual(status, 409)
        self.assertTrue(result['courseUnavailable'])
        self.assertNotIn('authInvalid', result)
        grab.assert_not_called()

    def test_course_lookup_fetches_new_credentials_each_time(self):
        session = Mock()
        session.request.side_effect = [
            (200, 'application/json', json.dumps({'ok': True, 'data': {
                'courseDeviceViewDtoList': [{
                    'chanNameMain': '课件',
                    'chanNameMainPlayUrl': 'https://mss2.sjtu.edu.cn/live/a.m3u8?auth_key=' + key,
                    'mainTokenStr': token,
                }]}}).encode(), '')
            for key, token in [('old', 'old-token'), ('fresh', 'fresh-token')]
        ]
        urls = [bridge.live_stream_url(bridge.live_course_view(session, 123)[1])
                for _ in range(2)]
        self.assertIn('auth_key=old&account_token=old-token', urls[0])
        self.assertIn('auth_key=fresh&account_token=fresh-token', urls[1])
        self.assertEqual(session.request.call_count, 2)

    def test_token_encoding_and_replacement_preserve_signature(self):
        url = bridge.live_stream_url({
            'chanNameMainPlayUrl': 'https://mss2.sjtu.edu.cn/live/a.m3u8?auth_key=a%2Bb&account_token=old',
            'mainTokenStr': 'a+b/c==',
        })
        self.assertIn('auth_key=a%2Bb&', url)
        self.assertEqual(parse_qs(urlsplit(url).query)['account_token'], ['a+b/c=='])

    def test_course_auth_errors_trigger_login(self):
        for status, body in [(401, b''), (403, b''), (500, b''),
                             (200, b'<html>Login</html>'),
                             (200, b'{"code":"401","data":null}')]:
            with self.subTest(status=status, body=body):
                session = Mock()
                session.request.return_value = (status, '', body, '')
                with self.assertRaises(bridge.LiveAuthError):
                    bridge.live_course_view(session, 123)

    def test_no_stream_is_not_an_auth_error(self):
        session = Mock()
        session.request.return_value = (200, '', b'{"data":{}}', '')
        with self.assertRaises(ValueError) as raised:
            bridge.live_course_view(session, 123)
        self.assertNotIsInstance(raised.exception, bridge.LiveAuthError)

    def test_stream_403_does_not_retry_same_url_in_ffmpeg(self):
        with patch.object(bridge.requests, 'get', return_value=Mock(status_code=403)), \
                patch.object(bridge, 'ffmpeg_grab_live') as ffmpeg:
            with self.assertRaises(bridge.LiveAuthError):
                bridge.grab_live_frame('https://mss2.sjtu.edu.cn/live/a.m3u8')
            ffmpeg.assert_not_called()

    def test_segment_auth_error_triggers_login(self):
        playlist = Mock(status_code=200, is_redirect=False, text='#EXTM3U\nlatest.ts?auth_key=segment\n')
        with patch.object(bridge.requests, 'get', side_effect=[playlist, Mock(status_code=403)]):
            with self.assertRaises(bridge.LiveAuthError):
                bridge.fetch_latest_segment('https://mss2.sjtu.edu.cn/live/a.m3u8')

    def test_signed_master_playlist_and_latest_segment(self):
        master = Mock(status_code=200, is_redirect=False, text='#EXTM3U\nvariant.m3u8?auth_key=child\n')
        media = Mock(status_code=200, is_redirect=False, text='#EXTM3U\nold.ts?auth_key=old\nnew.ts?auth_key=new\n')
        segment = Mock(status_code=200, is_redirect=False, content=b'ts-data')
        with patch.object(bridge.requests, 'get', side_effect=[master, media, segment]) as get:
            self.assertEqual(bridge.fetch_latest_segment('https://mss2.sjtu.edu.cn/live/a.m3u8'), b'ts-data')
        self.assertEqual(get.call_args.args[0], 'https://mss2.sjtu.edu.cn/live/new.ts?auth_key=new')

    def test_decodes_last_frame_of_real_ts_segment(self):
        import cv2
        import numpy as np
        ts = bridge.ffmpeg_pipe([
            '-f', 'lavfi', '-i', 'color=c=red:s=128x72:r=10:d=1',
            '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:r=10:d=1',
            '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
            '-c:v', 'mpeg2video', '-g', '10', '-f', 'mpegts', 'pipe:1'])
        jpeg = bridge.ffmpeg_grab_segment(ts)
        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        self.assertIsNotNone(frame)
        blue, green, red = frame.mean(axis=(0, 1))
        self.assertGreater(blue, 200)
        self.assertLess(red, 30)
        self.assertLess(green, 30)

    def test_ffmpeg_auth_error_triggers_login(self):
        result = Mock(returncode=1, stdout=b'', stderr=b'Server returned 403 Forbidden')
        with patch.object(bridge.subprocess, 'run', return_value=result):
            with self.assertRaises(bridge.LiveAuthError):
                bridge.ffmpeg_pipe([])

    def test_frame_endpoint_exposes_auth_error_for_frontend_retry(self):
        handler = object.__new__(bridge.RequestHandler)
        body = b'{"courseId":123}'
        handler.path = '/api/bridge/live/frame'
        handler.server = SimpleNamespace(server_port=51896)
        handler.headers = {'Host': '127.0.0.1:51896', 'Content-Type': 'application/json',
                           'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.get_session = Mock(return_value=('session', Mock()))
        handler.respond = Mock()
        view = {'chanNameMainPlayUrl': 'https://mss2.sjtu.edu.cn/live/a.m3u8',
                'mainTokenStr': 'fresh-token'}
        with patch.object(bridge, 'live_course_view', return_value=({}, view)), \
                patch.object(bridge, 'grab_live_frame', side_effect=bridge.LiveAuthError('鉴权失败')):
            handler.do_POST()
        status, result = handler.respond.call_args.args
        self.assertEqual(status, 401)
        self.assertIs(result['authInvalid'], True)


if __name__ == '__main__':
    unittest.main()
