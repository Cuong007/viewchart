import { describe, expect, it } from "vitest";
import { decodeDnseOhlc } from "../../examples/dnse-adapter/dnse-adapter.ts";

function varint(value: number): number[] {
  const out: number[] = [];
  let n = value;
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
function bytesField(id: number, value: number[]): number[] {
  return [...varint((id << 3) | 2), ...varint(value.length), ...value];
}
function doubleField(id: number, value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...varint((id << 3) | 1), ...bytes];
}
function sample(symbol = "VN30F1M"): Uint8Array {
  const inner = [
    ...varint(8), ...varint(1_700_000_000),
    ...doubleField(2, 1234.5),
    ...doubleField(3, 1240.0),
    ...doubleField(4, 1230.0),
    ...doubleField(5, 1238.5),
    ...varint(48), ...varint(9876),
    ...bytesField(7, [...new TextEncoder().encode(symbol)]),
  ];
  return new Uint8Array(bytesField(2, inner));
}

describe("DNSE VN30F1M protobuf decoder", () => {
  it("decodes OHLCV and converts exchange seconds to milliseconds", () => {
    expect(decodeDnseOhlc(sample())).toEqual({
      time: 1_700_000_000,
      timestamp: 1_700_000_000_000,
      open: 1234.5,
      high: 1240,
      low: 1230,
      close: 1238.5,
      volume: 9876,
    });
  });

  it("ignores messages for symbols other than VN30F1M", () => {
    expect(decodeDnseOhlc(sample("VN30F2M"))).toBeNull();
  });

  it("rejects truncated protobuf payloads instead of emitting corrupt candles", () => {
    expect(() => decodeDnseOhlc(new Uint8Array([0x12, 0x08, 0x08]))).toThrow();
  });
});
