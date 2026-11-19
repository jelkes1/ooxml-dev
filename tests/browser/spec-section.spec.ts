import { expect, test, type Page, type Route } from "@playwright/test";

const pdfOrigin = "https://cdn.ooxml.dev";
const part1 = `${pdfOrigin}/ecma-376/part1.pdf`;

// The actual app/React router runs locally. Only the section service and PDF body
// are fixtures: no live API, search/model request, telemetry or PDF download.
const result = (partNumber = 1, pageNumber: number | null = 239, sectionId = "17.3.1.24") => ({
	results: [{ id: 1, partNumber, sectionId, title: "pBdr", content: "Paragraph borders", pageNumber, score: 1 }],
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

async function isolate(page: Page, section: (route: Route) => Promise<void>) {
	const pdfRequests: string[] = [];
	await page.addInitScript(() => {
		const state = window as Window & { createdPdfFrames: string[] };
		state.createdPdfFrames = [];
		new MutationObserver(records => {
			for (const record of records) for (const node of record.addedNodes) {
				if (!(node instanceof Element)) continue;
				const frames = node instanceof HTMLIFrameElement ? [node] : [...node.querySelectorAll("iframe")];
				for (const frame of frames) state.createdPdfFrames.push(frame.src);
			}
		}).observe(document, { childList: true, subtree: true });
	});
	await page.context().route("**/*", async route => {
		const url = new URL(route.request().url());
		if (url.origin === pdfOrigin) {
			pdfRequests.push(route.request().url());
			await route.fulfill({ contentType: "text/html", body: "<!doctype html><p>Public PDF navigation fixture</p>" });
		} else if (["/__test_api/section", "/__test_api/search"].includes(url.pathname)) {
			await section(route);
		} else if (url.origin === "http://127.0.0.1:19138" && ["GET", "HEAD"].includes(route.request().method())) {
			await route.continue();
		} else {
			await route.abort();
		}
	});
	return pdfRequests;
}

async function lookup(page: Page, query = "section=17.3.1.24&part=1") {
	await page.goto(`/spec?${query}`);
	await expect(page.getByText("Searching...", { exact: true })).toBeVisible();
}

test("explicit section waits for mapping, then opens printed239 as PDF249 without a default iframe", async ({ page }) => {
	const pending = deferred();
	const pdfs = await isolate(page, async route => {
		await pending.promise;
		await route.fulfill({ json: result() });
	});
	try {
		await lookup(page);
		await expect(page.locator("iframe")).toHaveCount(0, { timeout: 1500 });
		expect(pdfs).toEqual([]);
		await expect(page.getByRole("link", { name: "Open official PDF" })).toHaveAttribute("href", part1);
		await page.screenshot({ path: test.info().outputPath("pending.png") });
		pending.resolve();
		await expect(page.locator("iframe")).toHaveAttribute("src", `${part1}#page=249&toolbar=0&navpanes=0`);
		expect(pdfs).toEqual([part1]);
		expect(await page.evaluate(() => (window as Window & { createdPdfFrames: string[] }).createdPdfFrames)).toEqual([`${part1}#page=249&toolbar=0&navpanes=0`]);
		await page.screenshot({ path: test.info().outputPath("resolved.png") });
	} finally { pending.resolve(); }
});

test("a part2 deep link never mounts or preloads default part1", async ({ page }) => {
	const pending = deferred();
	const pdfs = await isolate(page, async route => {
		await pending.promise;
		await route.fulfill({ json: result(2, 77) });
	});
	try {
		await lookup(page, "section=9.1&part=2");
		await expect(page.locator("iframe")).toHaveCount(0, { timeout: 1500 });
		await expect(page.locator('link[rel="preload"][href$="part1.pdf"]')).toHaveCount(0);
		await expect(page.getByRole("link", { name: "Open official PDF" })).toHaveAttribute("href", `${pdfOrigin}/ecma-376/part2.pdf`);
		pending.resolve();
		await expect(page.locator("iframe")).toHaveAttribute("src", `${pdfOrigin}/ecma-376/part2.pdf#page=85&toolbar=0&navpanes=0`);
		expect(pdfs).toEqual([`${pdfOrigin}/ecma-376/part2.pdf`]);
	} finally { pending.resolve(); }
});

for (const failure of ["http", "missing", "invalid-page", "invalid-part", "malformed"] as const) {
	test(`${failure} lookup keeps the PDF unmounted and can retry successfully`, async ({ page }) => {
		let attempts = 0;
		const pdfs = await isolate(page, async route => {
			attempts++;
			if (attempts > 1) return route.fulfill({ json: result() });
			if (failure === "http") return route.fulfill({ status: 503, json: { error: "unavailable" } });
			if (failure === "missing") return route.fulfill({ json: { results: [] } });
			if (failure === "invalid-page") return route.fulfill({ json: result(1, null) });
			if (failure === "invalid-part") return route.fulfill({ json: result(9) });
			return route.fulfill({ json: { results: "invalid" } });
		});
		await page.goto("/spec?section=17.3.1.24&part=1");
		await expect(page.getByRole("alert")).toBeVisible();
		if (failure === "http") await page.screenshot({ path: test.info().outputPath("lookup-error.png") });
		await expect(page.locator("iframe")).toHaveCount(0);
		expect(pdfs).toEqual([]);
		await expect(page.getByRole("link", { name: "Open official PDF" })).toHaveAttribute("href", part1);
		await page.getByRole("button", { name: "Retry section lookup" }).click();
		await expect(page.locator("iframe")).toHaveAttribute("src", `${part1}#page=249&toolbar=0&navpanes=0`);
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(attempts).toBe(2);
	});
}

test("normal no-section browsing immediately opens page1 and keeps page controls", async ({ page }) => {
	let lookups = 0;
	await isolate(page, async route => { lookups++; await route.abort(); });
	await page.goto("/spec");
	await expect(page.locator("iframe")).toHaveAttribute("src", `${part1}#page=11&toolbar=0&navpanes=0`);
	await page.getByRole("button", { name: "Next page" }).click();
	await expect(page.locator("iframe")).toHaveAttribute("src", `${part1}#page=12&toolbar=0&navpanes=0`);
	await expect(page.getByRole("button", { name: "Previous page" })).toBeEnabled();
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(lookups).toBe(0);
});

test("a user search can recover a failed explicit section lookup", async ({ page }) => {
	await isolate(page, async route => {
		if (new URL(route.request().url()).pathname.endsWith("/section")) {
			await route.fulfill({ status: 503, json: { error: "unavailable" } });
		} else {
			await route.fulfill({ json: result(2, 77, "9.1") });
		}
	});
	await page.goto("/spec?section=17.3.1.24&part=1");
	await expect(page.getByRole("alert")).toBeVisible();
	await page.locator("textarea").fill("package relationships");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(page.locator("iframe")).toHaveAttribute("src", `${pdfOrigin}/ecma-376/part2.pdf#page=85&toolbar=0&navpanes=0`);
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an ordinary query keeps default browsing while search is pending", async ({ page }) => {
	const pending = deferred();
	await isolate(page, async route => {
		await pending.promise;
		await route.fulfill({ json: result() });
	});
	try {
		await page.goto("/spec?q=paragraph%20borders");
		await expect(page.getByText("Searching...", { exact: true })).toBeVisible();
		await expect(page.locator("iframe")).toHaveAttribute("src", `${part1}#page=11&toolbar=0&navpanes=0`);
		pending.resolve();
		await expect(page.locator("iframe")).toHaveAttribute("src", `${part1}#page=249&toolbar=0&navpanes=0`);
	} finally { pending.resolve(); }
});

test("a newer section URL wins over a late previous lookup", async ({ page }) => {
	const old = deferred();
	await isolate(page, async route => {
		if (new URL(route.request().url()).searchParams.get("id") === "17.3.1.24") {
			await old.promise;
			await route.fulfill({ json: result() }).catch(() => {}); // Aborted by navigation after the fix.
		} else {
			await route.fulfill({ json: result(2, 77, "9.1") });
		}
	});
	try {
		await lookup(page);
		await page.evaluate(() => {
			history.pushState({}, "", "/spec?section=9.1&part=2");
			dispatchEvent(new PopStateEvent("popstate"));
		});
		await expect(page.locator("iframe")).toHaveAttribute("src", `${pdfOrigin}/ecma-376/part2.pdf#page=85&toolbar=0&navpanes=0`, { timeout: 2000 });
		old.resolve();
		await expect(page.locator("iframe")).toHaveAttribute("src", `${pdfOrigin}/ecma-376/part2.pdf#page=85&toolbar=0&navpanes=0`);
	} finally { old.resolve(); }
});
