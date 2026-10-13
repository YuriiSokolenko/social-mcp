import importlib.util
import socket
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "infra/github-runner-autoscaler/kvm-egress-proxy.py"
SPEC = importlib.util.spec_from_file_location("kvm_egress_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class EgressPolicyTests(unittest.TestCase):
    def test_only_exact_hosts_and_blob_storage_subdomains_are_allowed(self):
        self.assertTrue(proxy.allowed_host("api.github.com"))
        self.assertTrue(proxy.allowed_host("release-assets.githubusercontent.com."))
        self.assertTrue(proxy.allowed_host("run-123.blob.core.windows.net"))
        self.assertFalse(proxy.allowed_host("attacker.github.com"))
        self.assertFalse(proxy.allowed_host("blob.core.windows.net"))
        self.assertFalse(proxy.allowed_host("192.168.8.184"))

    @patch.object(proxy.socket, "getaddrinfo")
    def test_rejects_private_dns_answers_and_pins_public_answers(self, getaddrinfo):
        def record(address, family):
            sockaddr = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
            return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)

        getaddrinfo.return_value = [
            record("127.0.0.1", socket.AF_INET),
            record("192.168.8.184", socket.AF_INET),
            record("::1", socket.AF_INET6),
            record("93.184.216.34", socket.AF_INET),
        ]
        result = proxy.public_addresses("api.github.com", 443)
        self.assertEqual([socket.AF_INET], [family for family, _ in result])
        self.assertEqual(("93.184.216.34", 443), result[0][1])

    @patch.object(proxy.socket, "getaddrinfo", return_value=[
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.1", 443)),
    ])
    def test_fails_closed_when_allowed_name_resolves_only_to_private_ip(self, _getaddrinfo):
        with self.assertRaisesRegex(ValueError, "non-public"):
            proxy.public_addresses("api.github.com", 443)

if __name__ == "__main__":
    unittest.main()
