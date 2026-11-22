import json
from pathlib import Path
import unittest
from unittest.mock import Mock

from server.plugin_registry import load_plugin_upstreams


class PluginRegistryTests(unittest.TestCase):
    def test_absent_plugins_leave_core_services_unchanged(self):
        upstreams = {'core': 'https://my.sjtu.edu.cn'}
        cookies = {}
        directory = Path(__file__).resolve().parent / '.uninstalled-plugin-fixture'
        self.assertFalse(directory.exists())
        self.assertEqual(load_plugin_upstreams(directory, upstreams, cookies), [])
        self.assertEqual(upstreams, {'core': 'https://my.sjtu.edu.cn'})
        self.assertEqual(cookies, {})

    def test_broken_or_overriding_manifest_cannot_break_core(self):
        paths = []
        for name, text in {
            'foreign': json.dumps({'backend': {'upstreams': {'new': {'origin': 'https://outside.example'}}}}),
            'override': json.dumps({'backend': {'upstreams': {'core': {'origin': 'https://other.sjtu.edu.cn'}}}}),
            'broken': '{invalid',
        }.items():
            path = Mock()
            path.__lt__ = lambda a, b: a.parent.name < b.parent.name
            path.parent.name = name
            path.read_text.return_value = text
            paths.append(path)
        directory = Mock()
        directory.glob.return_value = paths
        upstreams = {'core': 'https://my.sjtu.edu.cn'}
        skipped = load_plugin_upstreams(directory, upstreams, {})
        self.assertEqual(set(skipped), {'foreign', 'override', 'broken'})
        self.assertEqual(upstreams, {'core': 'https://my.sjtu.edu.cn'})


if __name__ == '__main__':
    unittest.main()
