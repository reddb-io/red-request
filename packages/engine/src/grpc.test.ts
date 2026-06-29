import { describe, expect, it } from "vitest";
import { grpcCall } from "./grpc.js";

const PROTO = `
syntax = "proto3";
package demo;
service Greeter {
  rpc Hello (HelloRequest) returns (HelloReply);
}
message HelloRequest {
  string name = 1;
}
message HelloReply {
  string message = 1;
}
`;

describe("grpcCall", () => {
  it("preserves gRPC method and status metadata for local invocation failures", async () => {
    const response = await grpcCall({
      address: "127.0.0.1:50051",
      proto: PROTO,
      service: "demo.Greeter",
      method: "Hello",
      message: "{",
      plaintext: true,
      metadata: [],
    });

    expect(response.ok).toBe(false);
    expect(response.error?.classification).toBe("INVALID_ARGUMENT");
    expect(response.meta).toMatchObject({
      grpcStatus: "INVALID_ARGUMENT",
      method: "demo.Greeter/Hello",
    });
  });
});
