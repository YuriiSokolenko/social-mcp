"""Black-box checks for the running Compose application in CI."""

import json
import os
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

BASE_URL = os.environ.get("CI_BASE_URL")


@unittest.skipUnless(BASE_URL, "CI_BASE_URL is set only for the Docker integration job")
class RunningContainerTests(unittest.TestCase):
    def fetch(self, path: str) -> tuple[int, bytes]:
        with urlopen(f"{BASE_URL}{path}", timeout=5) as response:
            return response.status, response.read()

    def test_health_checks_live_storage(self) -> None:
        status, body = self.fetch("/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok"})

    def test_openapi_exposes_the_running_application(self) -> None:
        status, body = self.fetch("/openapi.json")
        document = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(document["info"]["title"], "Social MCP")
        self.assertIn("/health", document["paths"])

    def test_unknown_route_returns_not_found(self) -> None:
        with self.assertRaises(HTTPError) as error:
            self.fetch("/__ci_unknown_route__")
        self.assertEqual(error.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
