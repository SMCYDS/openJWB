# Independent HLS monitor

`hls_monitor.py` is a reusable MPEG-TS HLS worker. It has no imports of
openJWB, no SJTU domains, no course IDs, no login logic and no check-in logic.
Its inputs are an HLS URL, HTTP headers and an optional host allowlist.

```python
from hls_monitor import HLSMonitor

monitor = HLSMonitor(url, headers=headers).start()
cursor = 0
try:
    while True:
        event = monitor.next(cursor, timeout=20)
        if event:
            cursor = event['eventId']
            # event contains frame (base64 JPEG), qrText, receivedAt,
            # segmentDuration, fetchMs and qrMs.
finally:
    monitor.close()
```

Run it separately with the same dependencies as `server/requirements.txt`:

```text
python -B server/hls_monitor.py "https://example.com/live.m3u8" --header "Referer: https://example.com/"
```

The CLI writes JSON events to stdout. It does not open a network listener.
Do not put credentials in a shell command when testing private streams.

The ingest thread refreshes the playlist every 250 ms, compares media sequence
and segment path, downloads only the latest new segment and reuses its HTTP
session. One FFmpeg process decodes the stream, sampling at four frames per
second. A separate recognition thread reuses its QR detector, processes the
latest pending frame and drops superseded frames rather than accumulating a
queue. Recognition finishes before the image event is published. Newly detected
QR events are retained in a bounded buffer so a concurrent image update does
not erase them before delivery.
Byte-identical JPEGs reuse the previous recognition result instead of running
the detector again.

`receivedAt` is decoder receipt time, not classroom capture time. `fetchMs` and
`qrMs` measure their respective stages, not total end-to-end stream delay.
Encrypted HLS and fragmented MP4 require a different decoder adapter and are
reported as unsupported.

openJWB integration is confined to `/api/bridge/live/watch` in
`requestHandler.py`: resolve the authenticated course URL, acquire a worker
lease, long-poll events, and release the lease. Each browser session owns its
own `MonitorPool`; same-course consumers share one decoder within that session.
No jAccount cookie or JWT is passed to the worker. A stream authorization failure
returns to `jwlive`'s existing login retry flow. The worker stops on the final
lease release, course deadline, stream failure or 45 seconds without consumers
polling. Session closure also stops all its workers.
