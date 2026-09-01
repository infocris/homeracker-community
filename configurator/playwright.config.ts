import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	retries: 0,
	// Two, not the default four: WebGL runs on swiftshader here, so each page spends
	// ~4.7s compiling shaders before it can be driven. Four workers contend for the
	// CPU badly enough that startup gates expire — and a longer gate makes it worse,
	// since a stalled worker then holds the CPU longer.
	workers: 2,
	use: {
		baseURL: "http://localhost:3001",
		viewport: { width: 1280, height: 800 },
		// Use software rendering for headless WebGL
		launchOptions: {
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--enable-webgl",
				"--use-gl=angle",
				"--use-angle=swiftshader",
			],
		},
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
	webServer: {
		command: "bun run scripts/dev-server.ts",
		port: 3001,
		reuseExistingServer: !process.env.CI,
		timeout: 15_000,
	},
});
