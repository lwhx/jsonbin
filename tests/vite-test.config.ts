import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Resolve local variables beside the test config, never from the developer's .dev.vars.
  plugins: [react(), tailwindcss(), cloudflare({ configPath: "tests/wrangler.jsonc", persistState: false })],
});
