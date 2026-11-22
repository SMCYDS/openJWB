"""Read optional installed-plugin bridge declarations without importing plugin code."""
import json
import re
from urllib.parse import urlsplit


def load_plugin_upstreams(directory, upstreams, exposed_cookies):
    skipped = []
    for path in sorted(directory.glob('*/manifest.json')):
        try:
            manifest = json.loads(path.read_text(encoding='utf-8'))
            declarations = manifest.get('backend', {}).get('upstreams', {})
            pending = {}
            for service, definition in declarations.items():
                if not re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', service) or service in upstreams:
                    raise ValueError('Invalid or duplicate service')
                origin = definition['origin']
                parsed = urlsplit(origin)
                if (parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.sjtu.edu.cn')
                        or parsed.port not in (None, 443) or parsed.username or parsed.password
                        or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
                    raise ValueError('Plugin origin must be an HTTPS SJTU origin')
                cookies = definition.get('exposedCookies', [])
                if not isinstance(cookies, list) or any(not isinstance(name, str) or
                        not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', name) for name in cookies):
                    raise ValueError('Invalid exposed cookie names')
                pending[service] = (origin.rstrip('/'), set(cookies))
            for service, (origin, cookies) in pending.items():
                upstreams[service] = origin
                exposed_cookies[service] = cookies
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            skipped.append(path.parent.name)
    return skipped
