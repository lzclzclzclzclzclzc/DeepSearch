"""Browser acceptance with a deterministic HTTP fixture; never calls the paid API."""
import json
import os
import re
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("TEST_BASE_URL", "http://localhost:3333")
OUTPUT = Path(__file__).resolve().parents[2] / ".runtime" / "test-results" / "browser"
OUTPUT.mkdir(parents=True, exist_ok=True)


class BrowserAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        opts = {"headless": True}
        if os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
            opts["executable_path"] = os.environ["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
        cls.browser = cls.playwright.chromium.launch(**opts)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1000}, color_scheme="light")
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.posts = []
        self.gets = []
        self.clears = 0
        self.expired = False
        self.failed_page = False
        self.key_status = {"configured": False, "source": "none", "state": "saved"}
        self.saved_keys = []
        self.page.route("**/api/**", self.api)
        self.page.goto(BASE)
        self.page.wait_for_load_state("networkidle")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Browser must have no uncaught/hydration errors")

    def response(self, page=1, query="Rust", count=37):
        now = datetime.now(timezone.utc)
        total = (count + 9) // 10
        return {"requestId": "browser-test", "searchId": "12345678-1234-1234-1234-123456789012", "query": query, "effectiveQuery": query,
                "fetchedAt": now.isoformat(), "expiresAt": (now + timedelta(minutes=30)).isoformat(), "cache": "miss",
                "results": [{"sourceId": f"S{i:02d}", "title": f"Rust 异步编程指南 · 第 {i} 个来源", "url": f"https://example.com/article/{i}", "domain": "example.com", "siteName": "Rust 学习社区", "snippet": "从基础概念到实际项目，了解异步运行时如何工作。结合代码示例与最佳实践，构建清晰、可靠的应用程序。阅读完整文章，探索更多细节。", "publishedAt": "2026-10-20T00:00:00Z" if i % 2 else None} for i in range((page - 1) * 10 + 1, min(page * 10, count) + 1)],
                "snapshotCount": count, "page": page, "pageSize": 10, "totalPages": total, "hasPreviousPage": page > 1, "hasNextPage": page < total, "warnings": []}

    def api(self, route):
        request = route.request
        path = urlparse(request.url).path
        if path == "/api/search" and request.method == "POST":
            payload = request.post_data_json
            self.posts.append(payload)
            route.fulfill(json=self.response(query=payload["query"], count=0 if payload["query"] == "empty" else 37))
        elif path.startswith("/api/search/"):
            number = int(parse_qs(urlparse(request.url).query).get("page", [1])[0])
            self.gets.append(number)
            if self.expired:
                route.fulfill(status=410, json={"error": {"code": "SNAPSHOT_EXPIRED", "message": "本次搜索已过期，请主动重新搜索。", "retryable": False}, "requestId": "test"})
            elif self.failed_page:
                route.fulfill(status=503, json={"error": {"code": "SERVICE_UNAVAILABLE", "message": "服务暂时不可用。", "retryable": True}, "requestId": "test"})
            else:
                route.fulfill(json=self.response(page=number))
        elif path == "/api/session/data":
            self.clears += 1
            route.fulfill(json={"cleared": True, "requestId": "test"})
        elif path == "/api/session/config":
            if request.method == "POST":
                self.saved_keys.append(request.post_data_json["apiKey"])
                self.key_status = {"configured": True, "source": "personal", "state": "saved"}
            elif request.method == "DELETE":
                self.key_status = {"configured": False, "source": "none", "state": "saved"}
            route.fulfill(json=self.key_status)
        elif path == "/api/usage/today":
            route.fulfill(json={"day": "2026-10-22", "timeZone": "Asia/Shanghai", "totalCny": 10.015, "confirmedCny": 10, "pendingCny": 0.005, "uncertainCny": 0.01, "attempts": 2003, "paidSearches": 2000})
        else:
            route.fulfill(status=503, json={"status": "unavailable"})

    def search(self, text="Rust"):
        self.page.get_by_role("searchbox", name="搜索关键词").fill(text)
        self.page.get_by_role("button", name="搜索", exact=True).click()
        expect(self.page.get_by_role("article")).to_have_count(0 if text == "empty" else 10)
        if text != "empty":
            expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 1–10 条")

    def test_pagination_refresh_back_filters_and_safe_links(self):
        self.search()
        expect(self.page.get_by_role("button", name="上一页", exact=True)).to_be_disabled()
        self.page.get_by_role("button", name="第 4 页", exact=True).click()
        expect(self.page.get_by_role("article")).to_have_count(7)
        expect(self.page.get_by_role("button", name="下一页", exact=True)).to_be_disabled()
        self.assertEqual(len(self.posts), 1)
        self.page.reload()
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 31–37 条")
        self.assertEqual(len(self.posts), 1)
        self.page.go_back()
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 1–10 条")
        self.page.get_by_label("结果语言", exact=True).select_option("en")
        expect(self.page).to_have_url(re.compile("lang=en"))
        self.assertEqual(self.posts[-1]["filters"]["languages"], ["en"])
        self.assertEqual(self.posts[-1]["query"], "Rust")
        link = self.page.get_by_role("article").first.get_by_role("link")
        self.assertEqual(link.get_attribute("rel"), "noopener noreferrer")
        self.assertEqual(link.get_attribute("referrerpolicy"), "no-referrer")
        self.page.screenshot(path=str(OUTPUT / "results-desktop-light.png"), full_page=True)

    def test_themes_system_persistence_and_no_search_on_toggle(self):
        self.context.close()
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1000}, color_scheme="dark")
        self.page = self.context.new_page()
        self.page.route("**/api/**", self.api)
        self.page.goto(BASE)
        self.page.wait_for_load_state("networkidle")
        self.assertEqual(self.page.locator("html").evaluate("el => getComputedStyle(el).colorScheme"), "dark")
        self.page.screenshot(path=str(OUTPUT / "home-desktop-dark.png"), full_page=True)
        self.page.get_by_role("button", name="切换为浅色主题").click()
        self.page.reload()
        expect(self.page.locator("html")).to_have_attribute("data-theme", "light")
        self.assertEqual(len(self.posts), 0)
        self.search()
        self.page.get_by_role("button", name="第 2 页", exact=True).click()
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 11–20 条")
        request_count = len(self.posts) + len(self.gets)
        self.page.get_by_role("button", name="切换为深色主题").click()
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 11–20 条")
        self.assertEqual(len(self.posts) + len(self.gets), request_count)

    def test_mobile_tablet_both_themes_without_overflow(self):
        self.page.emulate_media(reduced_motion="reduce")
        for width in (375, 768, 1440):
            self.page.set_viewport_size({"width": width, "height": 900})
            self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
            self.page.screenshot(path=str(OUTPUT / f"home-{width}-light.png"), full_page=True)
            self.page.get_by_role("button", name="切换为深色主题").click()
            self.page.screenshot(path=str(OUTPUT / f"home-{width}-dark.png"), full_page=True)
            self.page.get_by_role("button", name="切换为浅色主题").click()
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.search()
        expect(self.page.get_by_role("button", name="下一页", exact=True)).to_be_visible()
        self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
        self.page.screenshot(path=str(OUTPUT / "results-mobile-light.png"), full_page=True)
        self.page.get_by_role("button", name="切换为深色主题").click()
        self.page.screenshot(path=str(OUTPUT / "results-mobile-dark.png"), full_page=True)
        for width in (768, 1440):
            self.page.set_viewport_size({"width": width, "height": 900})
            self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
            self.page.screenshot(path=str(OUTPUT / f"results-{width}-dark.png"), full_page=True)
            self.page.get_by_role("button", name="切换为浅色主题").click()
            self.page.screenshot(path=str(OUTPUT / f"results-{width}-light.png"), full_page=True)
            self.page.get_by_role("button", name="切换为深色主题").click()
        self.page.set_viewport_size({"width": 375, "height": 812})
        self.page.get_by_role("button", name="全部站点", exact=False).click()
        expect(self.page.get_by_placeholder("例如 wikipedia.org")).to_be_visible()
        self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))

    def test_empty_expired_and_failed_page_preserves_old_results(self):
        self.search("empty")
        expect(self.page.get_by_role("heading", name="有时候，换个问法就能找到。")).to_be_visible()
        expect(self.page.get_by_role("navigation", name="搜索结果分页")).to_have_count(0)
        self.search()
        self.failed_page = True
        self.page.get_by_role("button", name="第 2 页", exact=True).click()
        expect(self.page.locator("#search-error")).to_contain_text("服务暂时不可用")
        expect(self.page.get_by_role("article")).to_have_count(10)
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 1–10 条")
        self.failed_page = False
        self.expired = True
        self.page.get_by_role("button", name="第 2 页", exact=True).click()
        expect(self.page.locator("#search-error")).to_contain_text("本次搜索已过期")
        self.assertEqual(len(self.posts), 2)

    def test_ime_clear_session_and_query_validation(self):
        field = self.page.get_by_role("searchbox", name="搜索关键词")
        field.fill("中文搜索")
        field.dispatch_event("compositionstart")
        field.press("Enter")
        self.assertEqual(len(self.posts), 0)
        field.dispatch_event("compositionend")
        field.press("Enter")
        expect(self.page.get_by_role("article")).to_have_count(10)
        self.assertEqual(len(self.posts), 1)
        self.page.get_by_role("button", name="清除会话数据").click()
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("让好奇")
        self.assertEqual(self.clears, 1)
        self.page.get_by_role("searchbox", name="搜索关键词").fill("😀" * 129)
        self.page.get_by_role("button", name="搜索", exact=True).click()
        expect(self.page.locator("#search-error")).to_contain_text("128")
        self.assertEqual(len(self.posts), 1)

    def test_rapid_pagination_ignores_old_response(self):
        self.search()
        held = []

        def pages(route):
            number = int(parse_qs(urlparse(route.request.url).query).get("page", [1])[0])
            if number == 2:
                held.append(route)
            else:
                route.fulfill(json=self.response(page=number))

        self.page.route("**/api/search/*", pages)
        self.page.get_by_role("button", name="第 2 页", exact=True).click()
        self.page.get_by_role("button", name="第 3 页", exact=True).click()
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 21–30 条")
        self.assertTrue(held)
        held[0].fulfill(json=self.response(page=2))
        expect(self.page.get_by_role("heading", level=1)).to_contain_text("第 21–30 条")
        self.assertEqual(len(self.posts), 1)

    def test_keyboard_focus_and_theme_contrast(self):
        self.page.keyboard.press("Tab")
        expect(self.page.get_by_role("link", name="跳转到主要内容")).to_be_focused()
        for _ in range(2):
            ratios = self.page.evaluate("""() => {
              const css = getComputedStyle(document.documentElement);
              const value = key => css.getPropertyValue(key).trim();
              const lum = hex => {
                let h = hex.slice(1); if (h.length === 3) h = h.split('').map(x => x+x).join('');
                const c = [0,2,4].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
                return c[0]*.2126+c[1]*.7152+c[2]*.0722;
              };
              const contrast = (a,b) => { const x=lum(value(a)),y=lum(value(b));return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
              return [['--text','--bg'],['--text-muted','--bg'],['--accent','--bg'],['--selected-text','--selected-bg'],['--control-border','--surface']].map(pair=>contrast(...pair));
            }""")
            for ratio in ratios[:4]:
                self.assertGreaterEqual(ratio, 4.5)
            self.assertGreaterEqual(ratios[4], 3)
            self.page.get_by_role("button", name=re.compile("切换为.*主题")).click()

    def test_settings_key_save_remove_and_keyboard(self):
        self.page.get_by_role("button", name="设置", exact=True).click()
        modal = self.page.get_by_role("dialog", name="设置", exact=True)
        expect(modal).to_be_visible()
        expect(modal).to_contain_text("配置 API key")
        expect(modal).to_contain_text("尚未配置密钥")
        usage = modal.get_by_test_id("today-spending")
        expect(usage).to_contain_text("10.0150")
        expect(usage).to_contain_text("本站全部调用")
        expect(usage).to_contain_text("2003")
        modal.get_by_role("button", name="刷新今日开销").click()
        expect(usage).to_contain_text("10.0150")

        field = modal.get_by_label("DeepSeek API key", exact=True)
        self.assertEqual(field.get_attribute("type"), "password")
        field.fill("browser-test-key-not-real")
        modal.get_by_role("button", name="保存密钥", exact=True).click()
        expect(modal).to_contain_text("已配置个人密钥")
        expect(field).to_have_value("")
        self.assertEqual(self.saved_keys, ["browser-test-key-not-real"])
        self.assertNotIn("browser-test-key-not-real", self.page.content())
        self.assertEqual(len(self.posts), 0)
        self.page.keyboard.press("Escape")
        expect(modal).not_to_be_visible()
        self.page.get_by_role("button", name="设置", exact=True).click()
        expect(modal).to_contain_text("已配置个人密钥")
        for width in (375, 768, 1440):
            self.page.set_viewport_size({"width": width, "height": 900})
            self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
            self.page.screenshot(path=str(OUTPUT / f"settings-{width}-light.png"), full_page=True)
        modal.get_by_role("button", name="移除个人密钥").click()
        expect(modal).to_contain_text("尚未配置密钥")

    def test_whale_girl_brand_assets_in_both_themes(self):
        logo = self.page.locator('header a[aria-label="DeepSearch 首页"] img')
        expect(logo).to_have_attribute("src", "/brand/whale-girl.webp")
        expect(logo).to_be_visible()
        self.assertTrue(logo.evaluate("image => image.complete && image.naturalWidth > 0"))
        expect(self.page.locator('link[rel="icon"][sizes="32x32"]')).to_have_attribute("href", "/brand/icon-32.png")
        expect(self.page.locator('link[rel="apple-touch-icon"]')).to_have_attribute("href", "/brand/apple-touch-icon.png")
        favicon = self.page.request.get(BASE + "/brand/icon-32.png")
        self.assertEqual(favicon.status, 200)
        self.assertIn("image/png", favicon.headers["content-type"])
        self.page.emulate_media(reduced_motion="reduce")
        self.page.screenshot(path=str(OUTPUT / "whale-girl-home-light.png"), full_page=True)
        self.page.get_by_role("button", name="切换为深色主题").click()
        self.page.set_viewport_size({"width": 375, "height": 812})
        expect(logo).to_be_visible()
        self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
        self.page.screenshot(path=str(OUTPUT / "whale-girl-mobile-dark.png"), full_page=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
