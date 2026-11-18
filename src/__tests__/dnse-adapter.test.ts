import { describe, expect, it } from "vitest";
import { decodeDnseOhlc } from "../../examples/dnse-adapter/dnse-adapter.ts";

function varint(value:number):number[] {
  const out:number[]=[];let n=value;
  while(n>127){out.push((n&127)|128);n=Math.floor(n/128);}
  out.push(n);return out;
}
function fieldVarint(id:number,value:number):number[] { return [...varint(id*8),...varint(value)]; }
function fieldBytes(id:number,value:Uint8Array):number[] { return [...varint(id*8+2),...varint(value.length),...value]; }
function frame(symbol="VN30F1M"):Uint8Array {
  const payload=[
    ...fieldVarint(1,1731920400),...fieldVarint(2,1245),...fieldVarint(3,1250),
    ...fieldVarint(4,1240),...fieldVarint(5,1248),...fieldVarint(6,99),
    ...fieldBytes(7,new TextEncoder().encode(symbol)),
  ];
  return new Uint8Array([...fieldBytes(2,new Uint8Array(payload))]);
}
describe("DNSE OHLC protobuf decoder",()=>{
  it("decodes a VN30F1M envelope into a chart candle",()=>{
    expect(decodeDnseOhlc(frame())).toEqual({
      time:1731920400,open:1245,high:1250,low:1240,close:1248,volume:99,timestamp:1731920400000,
    });
  });
  it("ignores messages for other instruments",()=>{
    expect(decodeDnseOhlc(frame("VN30F2M"))).toBeNull();
  });
});
