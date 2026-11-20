// Import this first in every entry point (page, key worker, service worker). The CSP has no
// 'unsafe-eval', so zod must not try to compile its fast-path parsers with Function().
import { z } from "zod";

z.config({ jitless: true });
