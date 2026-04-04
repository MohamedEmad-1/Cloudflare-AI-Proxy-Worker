import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("AI router worker", () => {
	it("returns 401 without master key", async () => {
		const request = new Request("http://example.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "deepseekv3", messages: [{ role: "user", content: "Hello" }] }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

	it("returns 400 for invalid payload", async () => {
		const request = new Request("http://example.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.MASTER_KEY}`,
			},
			body: JSON.stringify({ model: "deepseekv3" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("Invalid request body");
	});

	it("returns 400 for unknown model pool", async () => {
		const request = new Request("http://example.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.MASTER_KEY}`,
			},
			body: JSON.stringify({
				model: "not-a-pool",
				messages: [{ role: "user", content: "Hello" }],
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("Unknown model pool");
	});
});
