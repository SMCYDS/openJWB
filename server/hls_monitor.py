"""Independent HLS -> latest JPEG/QR worker. No application login or course logic.

Can also run alone: python -B server/hls_monitor.py URL --header 'Referer: ...'
The CLI emits JSON events on stdout; credentials and stream URLs are never logged.
"""
import argparse
import base64
from collections import deque
import json
import re
import secrets
import subprocess
import threading
import time
from urllib.parse import urljoin, urlsplit

import requests


class StreamAuthError(ValueError):
    pass


class HLSClient:
    def __init__(self, url, headers=None, allowed_hosts=None):
        self.url = url
        self.allowed_hosts = set(allowed_hosts or [urlsplit(url).hostname])
        self.allowed_ports = {None, 80, 443, urlsplit(url).port}
        self.allowed_schemes = {'https'} if urlsplit(url).scheme == 'https' else {'http', 'https'}
        self.http = requests.Session()
        self.http.headers.update(headers or {})

    def get(self, url, limit):
        parsed = urlsplit(url)
        if (parsed.scheme not in self.allowed_schemes or parsed.hostname not in self.allowed_hosts
                or parsed.username or parsed.password or parsed.port not in self.allowed_ports):
            raise ValueError('Stream host is not allowed')
        with self.http.get(url, timeout=(5, 8), allow_redirects=False, stream=True) as response:
            if response.status_code in (401, 403):
                raise StreamAuthError('Stream authorization expired')
            if response.is_redirect:
                raise ValueError('Unexpected stream redirect')
            if response.status_code >= 400:
                raise ValueError(f'Stream HTTP {response.status_code}')
            chunks, size = [], 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ValueError('Stream resource exceeds size limit')
                chunks.append(chunk)
            return b''.join(chunks)

    def latest(self, url=None, depth=0):
        if depth > 4:
            raise ValueError('Playlist nesting exceeds limit')
        url = url or self.url
        text = self.get(url, 1024 * 1024).decode('utf-8-sig')
        if not text.startswith('#EXTM3U'):
            raise ValueError('Invalid HLS playlist')
        if '#EXT-X-KEY:' in text and re.search(r'METHOD=(?!NONE)[A-Z0-9-]+', text):
            raise ValueError('Encrypted HLS is not supported by this worker')
        if '#EXT-X-MAP:' in text:
            raise ValueError('This worker requires MPEG-TS HLS segments')
        sequence = int(re.search(r'#EXT-X-MEDIA-SEQUENCE:(\d+)', text)[1]) if '#EXT-X-MEDIA-SEQUENCE:' in text else 0
        segments, duration = [], 0.0
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith('#EXTINF:'):
                duration = float(line.split(':', 1)[1].split(',')[0])
            elif line and not line.startswith('#'):
                segments.append((urljoin(url, line), duration))
        if not segments:
            return None
        last_url, duration = segments[-1]
        if urlsplit(last_url).path.endswith('.m3u8'):
            return self.latest(last_url, depth + 1)
        # Ignore changing signatures when deciding whether this is a new media segment.
        identity = (sequence + len(segments) - 1, urlsplit(last_url).path)
        return identity, last_url, duration, '#EXT-X-ENDLIST' in text

    def close(self):
        self.http.close()


class PersistentDecoder:
    """One FFmpeg process for the entire watch; bounded latest-frame handoff."""
    def __init__(self, on_frame):
        import imageio_ffmpeg
        self.on_frame = on_frame
        self.closed = False
        self.process = subprocess.Popen([
            imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
            '-probesize', '2048', '-analyzeduration', '1', '-flags', 'low_delay',
            '-f', 'mpegts', '-i', 'pipe:0', '-an', '-vf', 'fps=4',
            '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', '-flush_packets', '1', 'pipe:1'
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        buffer = bytearray()
        try:
            while not self.closed:
                chunk = self.process.stdout.read(64 * 1024)
                if not chunk:
                    return
                buffer.extend(chunk)
                if len(buffer) > 8 * 1024 * 1024:
                    buffer.clear()
                    continue
                while True:
                    start = buffer.find(b'\xff\xd8')
                    end = buffer.find(b'\xff\xd9', start + 2) if start >= 0 else -1
                    if end < 0:
                        break
                    jpeg = bytes(buffer[start:end + 2])
                    del buffer[:end + 2]
                    self.on_frame(jpeg)
        except (OSError, ValueError):
            return

    def feed(self, data):
        if self.process.poll() is not None:
            raise ValueError('Video decoder stopped')
        # FileIO.write may write fewer bytes than requested on a pipe.
        view = memoryview(data)
        while view and not self.closed:
            count = self.process.stdin.write(view)
            if not count:
                raise ValueError('Video decoder input closed')
            view = view[count:]

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        for pipe in (self.process.stdin, self.process.stdout):
            pipe.close()
        if threading.current_thread() is not self.reader:
            self.reader.join(timeout=1)

    def finish(self):
        """Flush the final segment on a clean HLS end before shutting down."""
        if not self.closed and self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=2)
                self.reader.join(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        self.close()


class QRRecognizer:
    def __init__(self):
        import cv2
        import numpy
        self.cv2, self.np = cv2, numpy
        self.detector = cv2.QRCodeDetector()

    def __call__(self, jpeg):
        frame = self.cv2.imdecode(self.np.frombuffer(jpeg, self.np.uint8), self.cv2.IMREAD_COLOR)
        if frame is None:
            return None
        text, _, _ = self.detector.detectAndDecode(frame)
        return text or None


class HLSMonitor:
    def __init__(self, url, headers=None, allowed_hosts=None, detect_qr=True,
                 poll_interval=0.25, idle_timeout=45, lifetime=None,
                 client=None, decoder_factory=PersistentDecoder, recognizer=None):
        self.client = client or HLSClient(url, headers, allowed_hosts)
        self.detect_qr = detect_qr
        self.decoder_factory = decoder_factory
        self.recognizer = recognizer
        self.poll_interval = max(0.1, poll_interval)
        self.idle_timeout = idle_timeout
        self.deadline = time.monotonic() + lifetime if lifetime else None
        self.condition = threading.Condition()
        self.stopped = threading.Event()
        self.pending = None
        self.processing = False
        self.latest_event = None
        self.qr_events = deque(maxlen=8)
        self.error = None
        self.revision = 0
        self.last_activity = time.monotonic()
        self.segment_stats = {}
        self.decoder = None
        self.threads = []

    def start(self):
        self.threads = [threading.Thread(target=self._recognize, daemon=True),
                        threading.Thread(target=self._ingest, daemon=True)]
        for thread in self.threads:
            thread.start()
        return self

    def _queue_frame(self, jpeg):
        with self.condition:
            if self.stopped.is_set():
                return
            # Never queue an unbounded video backlog while QR detection is busy.
            self.pending = (jpeg, time.time() * 1000, dict(self.segment_stats))
            self.condition.notify_all()

    def _fail(self, error):
        with self.condition:
            self.error = error
            self.stopped.set()
            self.condition.notify_all()

    def _ingest(self):
        last_identity = None
        failures = 0
        clean_end = False
        try:
            self.decoder = self.decoder_factory(self._queue_frame)
            while not self.stopped.is_set():
                now = time.monotonic()
                if now - self.last_activity > self.idle_timeout or (self.deadline and now >= self.deadline):
                    clean_end = True
                    break
                try:
                    segment = self.client.latest()
                    if segment:
                        identity, url, duration, ended = segment
                        if identity != last_identity:
                            started = time.perf_counter()
                            data = self.client.get(url, 16 * 1024 * 1024)
                            self.segment_stats = {'segmentDuration': duration,
                                                  'fetchMs': round((time.perf_counter() - started) * 1000, 1)}
                            self.decoder.feed(data)
                            last_identity = identity
                        if ended:
                            clean_end = True
                            break
                    failures = 0
                except StreamAuthError:
                    raise
                except (requests.RequestException, ValueError, OSError):
                    failures += 1
                    if failures >= 3:
                        raise ValueError('Continuous stream fetch/decode failed') from None
                self.stopped.wait(self.poll_interval)
        except Exception as error:
            self._fail(error)
        finally:
            if self.decoder:
                if clean_end and not self.stopped.is_set():
                    self.decoder.finish()
                    with self.condition:
                        self.condition.wait_for(lambda: (self.pending is None and not self.processing)
                                                or self.stopped.is_set(), timeout=2)
                else:
                    self.decoder.close()
            self.client.close()
            self.stopped.set()
            with self.condition:
                self.condition.notify_all()

    def _recognize(self):
        try:
            recognize = (self.recognizer or QRRecognizer()) if self.detect_qr else lambda _: None
            last_jpeg = None
            while not self.stopped.is_set():
                with self.condition:
                    self.condition.wait_for(lambda: self.pending is not None or self.stopped.is_set())
                    if self.stopped.is_set():
                        return
                    jpeg, received_at, stats = self.pending
                    self.pending = None
                    if jpeg == last_jpeg:
                        self.condition.notify_all()
                        continue
                    self.processing = True
                started = time.perf_counter()
                qr_text = recognize(jpeg)
                # Recognition has priority; publish the image only after this result is ready.
                with self.condition:
                    if self.stopped.is_set():
                        return
                    self.revision += 1
                    event = {'eventId': self.revision, 'frame': base64.b64encode(jpeg).decode('ascii'),
                             'qrText': qr_text, 'receivedAt': received_at,
                             'qrMs': round((time.perf_counter() - started) * 1000, 1), **stats}
                    self.latest_event = event
                    last_jpeg = jpeg
                    self.processing = False
                    if qr_text:
                        self.qr_events.append(event)
                    self.condition.notify_all()
        except Exception:
            self._fail(ValueError('QR recognition failed'))

    def next(self, after=0, timeout=20):
        with self.condition:
            self.last_activity = time.monotonic()
            self.condition.wait_for(lambda: self.revision > after or self.stopped.is_set(), timeout)
            self.last_activity = time.monotonic()
            if self.error:
                raise self.error
            # Preserve a newly recognized QR even if a newer plain image arrived meanwhile.
            for event in reversed(self.qr_events):
                if event['eventId'] > after:
                    return dict(event)
            if self.latest_event and self.latest_event['eventId'] > after:
                return dict(self.latest_event)
            if self.stopped.is_set():
                raise EOFError('Stream ended')
            return None

    def close(self):
        self.stopped.set()
        with self.condition:
            self.condition.notify_all()
        if self.decoder:
            self.decoder.close()
        for thread in self.threads:
            if thread is not threading.current_thread():
                thread.join(timeout=1)


class MonitorPool:
    """Opaque consumer leases; multiple clients can share one stream worker."""
    def __init__(self, max_streams=2):
        self.max_streams = max_streams
        self.lock = threading.Lock()
        self.workers = {}
        self.leases = {}

    def acquire(self, key, factory, metadata=None):
        with self.lock:
            self.leases = {token: item for token, item in self.leases.items() if not item[1].stopped.is_set()}
            self.workers = {name: worker for name, worker in self.workers.items() if not worker.stopped.is_set()}
            if len(self.leases) >= 8:
                raise ValueError('Too many stream consumers')
            worker = self.workers.get(key)
            if worker is None or worker.stopped.is_set():
                active = sum(not item.stopped.is_set() for item in self.workers.values())
                if active >= self.max_streams:
                    raise ValueError('Too many active streams')
                worker = factory().start()
                self.workers[key] = worker
            token = secrets.token_urlsafe(24)
            self.leases[token] = (key, worker, metadata or {})
            return token

    def next(self, token, after=0, timeout=20):
        with self.lock:
            item = self.leases.get(token)
        if item is None:
            raise EOFError('Stream watch expired')
        _, worker, metadata = item
        event = worker.next(after, timeout)
        return {**event, **metadata} if event else None

    def release(self, token):
        worker_to_close = None
        with self.lock:
            item = self.leases.pop(token, None)
            if item:
                key, worker, _ = item
                if not any(other[1] is worker for other in self.leases.values()):
                    if self.workers.get(key) is worker:
                        del self.workers[key]
                    worker_to_close = worker
        if worker_to_close:
            worker_to_close.close()

    def close(self):
        with self.lock:
            workers = set(self.workers.values()) | {item[1] for item in self.leases.values()}
            self.workers.clear()
            self.leases.clear()
        for worker in workers:
            worker.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--header', action='append', default=[])
    args = parser.parse_args()
    headers = dict(value.split(':', 1) for value in args.header)
    monitor = HLSMonitor(args.url, {k.strip(): v.strip() for k, v in headers.items()}).start()
    cursor = 0
    try:
        while True:
            event = monitor.next(cursor)
            if event:
                cursor = event['eventId']
                print(json.dumps(event), flush=True)
    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        monitor.close()


if __name__ == '__main__':
    main()
