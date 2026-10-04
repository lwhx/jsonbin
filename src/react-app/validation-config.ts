import { z } from 'zod';

// Run before App's shared backup schemas are constructed. Zod's JIT feature
// probe itself violates strict CSP, even when it catches the resulting error.
z.config({ jitless: true });
