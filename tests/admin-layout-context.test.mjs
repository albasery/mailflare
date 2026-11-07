import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFixture } from "./helpers/fixtures.mjs";
const wrapper = name => `export const ${name}=({children})=>children;`;
const empty = name => `export const ${name}=()=>null;`;
const fixture = await loadFixture({ name: "admin-layout-context", entryPoint: "src/app/(admin)/layout.tsx", mocks: {
	"next/navigation": "export const usePathname=()=>'/domains';",
	"next/link": "export default function Link(){return null}",
	"@/components/icons": "export const HelpCircle=()=>null; export const Search=()=>null;",
	"@/components/language-provider": "export const useLanguage=()=>({t:key=>key});",
	"@/components/auth/auth-guard": wrapper("AuthGuard"),
	"@/components/mailbox-provider": wrapper("MailboxProvider"),
	"@/components/sidebar-state": wrapper("SidebarProvider"),
	"@/components/compose/compose-context": wrapper("ComposeProvider"),
	"@/components/shortcuts": wrapper("ShortcutsProvider"),
	"@/components/sidebar-aside": wrapper("SidebarAside") + empty("MobileTopBar"),
	"@/components/mailbox-selector": empty("MailboxSelector"),
	"@/components/license-indicator": empty("LicenseIndicator"),
	"@/components/route-title": empty("RouteTitle"),
	"@/components/sidebar-resize-boundary": empty("SidebarResizeBoundary"),
	"@/components/skip-to-content": empty("SkipToContent"),
	"@/components/compose/floating-composer": empty("FloatingComposer"),
	"@/components/admin-nav": `import {useMailSearch} from '${process.cwd()}/src/components/mail-search/mail-search-context.tsx'; export function AdminNav(){const search=useMailSearch(); return 'Navigation ready '+search.query;}`,
} });
const { default: Layout } = await fixture.import();
after(() => fixture.dispose());
test("admin navigation renders with the real mail-search context", () => {
	const html = renderToStaticMarkup(React.createElement(Layout, null, "Domains content"));
	assert.match(html, /Navigation ready/);
	assert.match(html, /Domains content/);
});
