"""Incremental decoder for newline-delimited JSON (NDJSON) byte streams.

:func:`decode_ndjson_stream` and :class:`NDJSONStreamDecoder` accept arbitrarily
split ``bytes`` chunks and return decoded JSON values only once a complete
logical record is buffered. The parser is strictly incremental: only the bytes
of the record currently being assembled are ever joined or decoded, never the
whole stream.

Deterministic error semantics
-----------------------------

* A logical record is every LF/CRLF-terminated segment of the stream, plus one
  optional final unterminated segment released by
  :meth:`NDJSONStreamDecoder.finish`. Records are numbered from 1 in the order
  the decoder consumes them; that number appears in the errors below.
* **Blank lines are skipped** and are *not* counted as logical records, so a
  blank line never shifts the numbering of the records around it and a stream
  containing only blank lines decodes to nothing. A segment is blank when it
  carries nothing but ASCII whitespace.
* **CRLF is stripped, not tolerated.** A record ends at LF and one optional
  immediately preceding CR is removed. Any other CR is left untouched and
  reaches :mod:`json`, which rejects a stray CR as invalid JSON. In particular,
  a JSON container that contains a raw newline is never merged with the
  following line; it is reported as invalid.
* **Invalid UTF-8** raises :class:`NDJSONUnicodeDecodeError` naming the
  offending record. The error surfaces as soon as that record's terminating LF
  is seen, so invalid bytes inside an incomplete trailing record are reported
  when :meth:`finish` supplies the rest of the stream.
* **Malformed JSON** raises :class:`NDJSONDecodeError` naming the record. Both
  error classes derive from :class:`NDJSONError`, itself a subclass of
  :class:`ValueError`.
* **Buffer limit.** ``max_record_bytes`` counts the bytes of one record, not
  counting its terminating LF or a stripped CR. As soon as the record currently
  being assembled is provably longer than that limit, the decoder raises
  :class:`NDJSONLimitExceededError` without waiting for the rest of the stream.
  A record of exactly ``max_record_bytes`` is still accepted.
* **No silent record loss.** Records that precede an invalid record are not
  dropped: :meth:`feed` consumes them, and the decoder keeps reporting them
  through ``records_decoded``.
* :meth:`finish` releases a final unterminated record and closes the decoder.
  A second :meth:`finish`, or any :meth:`feed` after it, raises
  :class:`NDJSONClosedError`.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

__all__ = [
    "NDJSONClosedError",
    "NDJSONDecodeError",
    "NDJSONError",
    "NDJSONLimitExceededError",
    "NDJSONStreamDecoder",
    "NDJSONUnicodeDecodeError",
    "decode_ndjson_stream",
]

_NEWLINE = 10  # b"\n"
_CR = b"\r"
_CR_BYTE = 13  # ord(b"\r")
_ASCII_WHITESPACE = b" \t\r\n\x0b\x0c"


class NDJSONError(ValueError):
    """Base class for every :mod:`ndjson_stream` decoding error."""


class NDJSONDecodeError(NDJSONError):
    """A logical record did not contain a valid JSON document."""

    def __init__(self, record_number: int, message: str) -> None:
        super().__init__(f"invalid JSON in record {record_number}: {message}")
        self.record_number = record_number


class NDJSONUnicodeDecodeError(NDJSONError):
    """A logical record was not valid UTF-8."""

    def __init__(self, record_number: int, cause: UnicodeDecodeError) -> None:
        super().__init__(f"invalid UTF-8 in record {record_number}: {cause}")
        self.record_number = record_number
        self.cause = cause


class NDJSONLimitExceededError(NDJSONError):
    """A logical record exceeded ``max_record_bytes``."""

    def __init__(self, record_number: int, max_record_bytes: int) -> None:
        super().__init__(
            f"record {record_number} exceeds the maximum record size of "
            f"{max_record_bytes} bytes"
        )
        self.record_number = record_number
        self.max_record_bytes = max_record_bytes


class NDJSONClosedError(NDJSONError):
    """The decoder was used after :meth:`NDJSONStreamDecoder.finish`."""


class NDJSONStreamDecoder:
    """Decode an NDJSON stream fed in arbitrarily split ``bytes`` chunks.

    Parameters
    ----------
    max_record_bytes:
        Maximum length in bytes of a single logical record, excluding its line
        terminator. Must be a positive :class:`int`. A record that is known to
        grow past this limit is rejected with
        :class:`NDJSONLimitExceededError` before it is complete.
    strict_unicode:
        When true (the default) a record with invalid UTF-8 raises
        :class:`NDJSONUnicodeDecodeError`, which names the record. When false,
        the standard-library :class:`UnicodeDecodeError` is forwarded instead.
    """

    __slots__ = (
        "_max_record_bytes",
        "_strict_unicode",
        "_buffer",
        "_pending_record_bytes",
        "_record_number",
        "_closed",
    )

    def __init__(
        self, max_record_bytes: int = 1_048_576, strict_unicode: bool = True
    ) -> None:
        if not isinstance(max_record_bytes, int) or isinstance(max_record_bytes, bool):
            raise TypeError("max_record_bytes must be a positive integer")
        if max_record_bytes <= 0:
            raise ValueError("max_record_bytes must be a positive integer")
        self._max_record_bytes = max_record_bytes
        self._strict_unicode = strict_unicode
        self._buffer = bytearray()
        self._pending_record_bytes = 0
        self._record_number = 0
        self._closed = False

    # -- public state ------------------------------------------------------

    @property
    def max_record_bytes(self) -> int:
        """Maximum accepted length of one logical record, in bytes."""
        return self._max_record_bytes

    @property
    def closed(self) -> bool:
        """Whether :meth:`finish` has already been called."""
        return self._closed

    @property
    def records_decoded(self) -> int:
        """How many logical records have been consumed so far."""
        return self._record_number

    @property
    def pending_bytes(self) -> int:
        """Bytes of the record currently being assembled."""
        return len(self._buffer)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"{type(self).__name__}(max_record_bytes={self._max_record_bytes!r}, "
            f"records_decoded={self._record_number!r}, closed={self._closed!r})"
        )

    # -- feeding -----------------------------------------------------------

    def feed(self, chunk: bytes) -> list[Any]:
        """Append ``chunk`` and return the values of the records it completed.

        Records already returned by an earlier successful :meth:`feed` are
        never re-emitted. When a record inside ``chunk`` is invalid, every
        record ahead of it has already been consumed and the bytes following it
        stay buffered, so no already-complete record is lost.

        Raises
        ------
        NDJSONClosedError
            If :meth:`finish` was already called.
        """
        if self._closed:
            raise NDJSONClosedError("cannot feed a decoder that has been finished")
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError("chunk must be a bytes-like object")
        view = memoryview(bytes(chunk))
        values: list[Any] = []
        start = 0
        while True:
            index = view.find(_NEWLINE, start)
            if index < 0:
                break
            segment = view[start:index]
            if segment[-1:] == _CR:
                segment = segment[:-1]
            if _is_blank(segment):
                start = index + 1
                continue
            record_number = self._record_number + 1
            self._pending_record_bytes += len(segment) + 1
            self._record_number = record_number
            try:
                values.append(self._decode(segment, record_number))
            except NDJSONError:
                # Keep the remainder of the chunk so an already-complete record
                # ahead of the failure is never lost or duplicated.
                self._buffer += view[index + 1 :]
                raise
            start = index + 1
        self._consume_tail(view, start)
        self._guard_limit()
        return values

    def finish(self) -> list[Any]:
        """Close the decoder, returning any final unterminated record's value.

        An empty or blank trailing segment yields no value. Afterwards the
        decoder accepts no further :meth:`feed` or :meth:`finish` call.
        """
        if self._closed:
            raise NDJSONClosedError("decoder has already been finished")
        try:
            self._guard_limit()
            if _is_blank(self._buffer):
                return []
            return [self._decode(self._buffer, self._record_number + 1)]
        finally:
            self._closed = True

    # -- internals ---------------------------------------------------------

    def _consume_tail(self, view: bytes, start: int) -> None:
        """Buffer the bytes from ``start`` on and refresh the pending size."""
        self._buffer += view[start:]
        self._pending_record_bytes += len(self._buffer)

    def _decode(self, segment: Any, record_number: int) -> Any:
        self._record_number = record_number
        try:
            text = bytes(segment).decode("utf-8")
        except UnicodeDecodeError as exc:
            if self._strict_unicode:
                raise NDJSONUnicodeDecodeError(record_number, exc) from None
            raise
        try:
            return json.loads(text)
        except ValueError as exc:
            raise NDJSONDecodeError(record_number, str(exc)) from None

    def _guard_limit(self) -> None:
        # A record is terminated by LF, which is not counted towards its size,
        # so the pending record is known to be too long only once the buffered
        # bytes already exceed the limit by that terminating byte.
        if self._pending_record_bytes - 1 > self._max_record_bytes:
            self._reset_pending()
            raise NDJSONLimitExceededError(
                self._record_number + 1, self._max_record_bytes
            )

    def _reset_pending(self) -> None:
        self._buffer.clear()
        self._pending_record_bytes = 0


def _is_blank(segment: Any) -> bool:
    """Whether a segment carries nothing but ASCII whitespace."""
    return not bytes(segment).strip(_ASCII_WHITESPACE)


def decode_ndjson_stream(
    chunks: Iterable[bytes],
    max_record_bytes: int = 1_048_576,
    strict_unicode: bool = True,
) -> list[Any]:
    """Decode every record of an iterable of ``bytes`` chunks.

    Chunks are consumed one at a time and the combined stream is *not*
    materialised before parsing. A missing terminating newline on the final
    chunk is accepted through :meth:`NDJSONStreamDecoder.finish`.

    Raises
    ------
    NDJSONError
        As described in the module docstring for the corresponding condition.
    """
    decoder = NDJSONStreamDecoder(
        max_record_bytes=max_record_bytes, strict_unicode=strict_unicode
    )
    values: list[Any] = []
    for chunk in chunks:
        values.extend(decoder.feed(chunk))
    values.extend(decoder.finish())
    return values
