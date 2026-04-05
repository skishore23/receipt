from __future__ import annotations

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run import classify_exception


class ClientError(Exception):
    def __init__(self, code: str, message: str = "simulated") -> None:
        super().__init__(message)
        self.response = {"Error": {"Code": code}}


class ClassifyExceptionTests(unittest.TestCase):
    def test_credentials_exceptions_fall_back_offline(self) -> None:
        for error_type in ("NoCredentialsError", "PartialCredentialsError"):
            error = type(error_type, (Exception,), {})(error_type)
            classified = classify_exception(error)
            self.assertIsNotNone(classified)
            self.assertEqual("offline", classified.mode)
            self.assertEqual(error_type, classified.error_type)

    def test_client_error_codes_fall_back_offline(self) -> None:
        for code in ("ExpiredToken", "UnrecognizedClientException"):
            classified = classify_exception(ClientError(code))
            self.assertIsNotNone(classified)
            self.assertEqual("offline", classified.mode)
            self.assertEqual("ClientError", classified.error_type)

    def test_network_exceptions_fall_back_offline(self) -> None:
        for error_type in ("EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError"):
            error = type(error_type, (Exception,), {})(error_type)
            classified = classify_exception(error)
            self.assertIsNotNone(classified)
            self.assertEqual("offline", classified.mode)
            self.assertEqual(error_type, classified.error_type)

    def test_unknown_error_does_not_fall_back(self) -> None:
        classified = classify_exception(Exception("other"))
        self.assertIsNone(classified)


if __name__ == "__main__":
    unittest.main()
