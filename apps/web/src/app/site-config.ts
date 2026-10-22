import type { SiteConfig } from "./site-config-schema";

declare const __PLAYWEFT_SITE_CONFIG__: SiteConfig;

/** Validated at build time; all values are public. */
export const siteConfig = __PLAYWEFT_SITE_CONFIG__;
