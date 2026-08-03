import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { bearerAuth } from "../src/auth/middleware.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function fakeReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

test("bearerAuth rejects a request with no Authorization header", () => {
  const middleware = bearerAuth(TOKEN);
  const { res, state } = fakeRes();
  let nextCalled = false;
  middleware(fakeReq(), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test("bearerAuth rejects a wrong token", () => {
  const middleware = bearerAuth(TOKEN);
  const { res, state } = fakeRes();
  let nextCalled = false;
  middleware(fakeReq({ authorization: "Bearer wrong-token-wrong-token-wrong" }), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test("bearerAuth rejects a non-Bearer scheme", () => {
  const middleware = bearerAuth(TOKEN);
  const { res, state } = fakeRes();
  let nextCalled = false;
  middleware(fakeReq({ authorization: TOKEN }), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test("bearerAuth calls next() for the correct token", () => {
  const middleware = bearerAuth(TOKEN);
  const { res } = fakeRes();
  let nextCalled = false;
  middleware(fakeReq({ authorization: `Bearer ${TOKEN}` }), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("bearerAuth is not fooled by a token supplied only as a query parameter", () => {
  // The middleware only ever reads the Authorization header, so a request
  // that merely carries the token in its URL must still be rejected.
  const middleware = bearerAuth(TOKEN);
  const { res, state } = fakeRes();
  let nextCalled = false;
  const req = fakeReq();
  (req as unknown as { query: Record<string, string> }).query = { token: TOKEN };
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});
