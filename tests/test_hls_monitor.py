import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import threading
import time
import unittest
from unittest.mock import Mock

from server.hls_monitor import HLSClient, HLSMonitor, MonitorPool


class FakeDecoder:
    def __init__(self, callback):
        self.callback = callback
        self.closed = False

    def feed(self, data):
        self.callback(data)

    def close(self):
        self.closed = True

    finish = close


class MonitorTests(unittest.TestCase):
    def test_recognition_precedes_publication_and_old_pending_frames_are_dropped(self):
        entered, release = threading.Event(), threading.Event()
        seen = []

        def recognize(jpeg):
            seen.append(jpeg)
            if jpeg == b'first':
                entered.set()
                release.wait(2)
                return 'qr-first'
            return None

        client = Mock()
        client.latest.return_value = None
        monitor = HLSMonitor('http://example.test/live', client=client,
                             decoder_factory=FakeDecoder, recognizer=recognize).start()
        try:
            monitor._queue_frame(b'first')
            self.assertTrue(entered.wait(1))
            self.assertIsNone(monitor.next(timeout=0.01), 'image must wait for QR detection')
            monitor._queue_frame(b'obsolete')
            monitor._queue_frame(b'newest')
            release.set()
            event = monitor.next(timeout=2)
            self.assertEqual(event['qrText'], 'qr-first')
            newer = monitor.next(after=event['eventId'], timeout=2)
            self.assertEqual(base64.b64decode(newer['frame']), b'newest')
            self.assertEqual(seen, [b'first', b'newest'])
            # A newer plain frame must not erase an undelivered QR event.
            self.assertEqual(monitor.next(after=0, timeout=0)['qrText'], 'qr-first')
        finally:
            release.set()
            monitor.close()

    def test_consumers_share_worker_and_release_last_lease(self):
        pool = MonitorPool()
        worker = Mock(stopped=threading.Event())
        worker.start.return_value = worker
        factory = Mock(return_value=worker)
        first = pool.acquire('course', factory)
        second = pool.acquire('course', factory)
        factory.assert_called_once()
        pool.release(first)
        worker.close.assert_not_called()
        pool.release(second)
        worker.close.assert_called_once()
        with self.assertRaises(EOFError):
            pool.next(second)

    def test_lease_is_not_visible_in_another_pool(self):
        pool = MonitorPool()
        worker = Mock(stopped=threading.Event())
        worker.start.return_value = worker
        lease = pool.acquire('course', lambda: worker)
        try:
            with self.assertRaises(EOFError):
                MonitorPool().next(lease)
        finally:
            pool.close()

    def test_idle_worker_stops_and_wakes_long_poll(self):
        client = Mock()
        client.latest.return_value = None
        monitor = HLSMonitor('http://example.test/live', client=client, idle_timeout=0.05,
                             decoder_factory=FakeDecoder, detect_qr=False).start()
        with self.assertRaises(EOFError):
            monitor.next(timeout=1)
        monitor.close()
        self.assertTrue(monitor.decoder.closed)

    def test_clean_end_delivers_final_recognized_frame(self):
        client = Mock()
        client.latest.return_value = ((1, '/last.ts'), 'http://example.test/last.ts', 2, True)
        client.get.return_value = b'last-image'
        monitor = HLSMonitor('http://example.test/live', client=client,
                             decoder_factory=FakeDecoder, recognizer=lambda _: 'final-qr').start()
        try:
            event = monitor.next(timeout=1)
            self.assertEqual(event['qrText'], 'final-qr')
            with self.assertRaises(EOFError):
                monitor.next(event['eventId'], timeout=1)
        finally:
            monitor.close()

    def test_client_rejects_foreign_host_before_request(self):
        client = HLSClient('https://allowed.test/live.m3u8')
        client.http.get = Mock()
        try:
            with self.assertRaises(ValueError):
                client.get('https://other.test/segment.ts', 1024)
            client.http.get.assert_not_called()
        finally:
            client.close()

    def test_standalone_real_hls_decode_qr_and_segment_deduplication(self):
        import cv2
        import imageio_ffmpeg
        qr_text = 'https://example.test/check-in?token=fixture'
        qr = cv2.QRCodeEncoder_create().encode(qr_text)
        qr = cv2.copyMakeBorder(qr, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
        qr = cv2.resize(qr, (384, 384), interpolation=cv2.INTER_NEAREST)
        segment = subprocess.run([
            imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
            '-f', 'rawvideo', '-pixel_format', 'gray', '-s', '384x384', '-r', '25',
            '-i', 'pipe:0', '-c:v', 'mpeg2video', '-g', '25', '-f', 'mpegts', 'pipe:1'
        ], input=qr.tobytes() * 50, capture_output=True, check=True).stdout
        counts = {'playlist': 0, 'segment': 0}

        class Fixture(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/live.m3u8':
                    counts['playlist'] += 1
                    data = b'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\none.ts\n'
                elif self.path == '/one.ts':
                    counts['segment'] += 1
                    data = segment
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        monitor = HLSMonitor(f'http://127.0.0.1:{server.server_port}/live.m3u8').start()
        try:
            event = monitor.next(timeout=8)
            self.assertIsNotNone(event)
            self.assertEqual(event['qrText'], qr_text)
            self.assertIsNotNone(cv2.imdecode(__import__('numpy').frombuffer(
                base64.b64decode(event['frame']), __import__('numpy').uint8), cv2.IMREAD_COLOR))
            process_id = monitor.decoder.process.pid
            time.sleep(0.55)
            self.assertEqual(counts['segment'], 1, 'same segment must never be downloaded twice')
            self.assertGreaterEqual(counts['playlist'], 2)
            self.assertEqual(monitor.decoder.process.pid, process_id)
            print(f"standalone HLS fixture: download={event['fetchMs']}ms QR={event['qrMs']}ms")
        finally:
            monitor.close()
            server.shutdown()
            server.server_close()
            server_thread.join(1)
        self.assertIsNotNone(monitor.decoder.process.poll())
        self.assertTrue(all(not thread.is_alive() for thread in monitor.threads))


if __name__ == '__main__':
    unittest.main()
