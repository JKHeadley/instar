// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://instar.sh',
  vite: {
    plugins: [tailwindcss()]
  },

  integrations: [
    starlight({
      title: 'Instar',
      logo: {
        src: './public/logo.png',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/JKHeadley/instar' },
      ],
      customCss: [
        './src/styles/starlight-custom.css',
      ],
      // Force dark mode to match landing page — no light/dark toggle
      expressiveCode: {
        themes: ['github-dark'],
      },
      head: [
        {
          tag: 'script',
          content: `
            // Force dark mode — Instar is always dark
            document.documentElement.dataset.theme = 'dark';
            localStorage.setItem('starlight-theme', 'dark');
          `,
        },
      ],
      components: {
        // Hide the theme toggle by overriding with empty component
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Installation', slug: 'installation' },
            { label: 'Quick Start', slug: 'quickstart' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [
            { label: 'The Coherence Problem', slug: 'concepts/coherence' },
            { label: 'Values & Identity', slug: 'concepts/values' },
            { label: 'Coherence Is Safety', slug: 'concepts/safety' },
            { label: 'Philosophy', slug: 'concepts/philosophy' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'Job Scheduler', slug: 'features/scheduler' },
            { label: 'Telegram Integration', slug: 'features/telegram' },
            { label: 'WhatsApp Integration', slug: 'features/whatsapp' },
            { label: 'Lifeline', slug: 'features/lifeline' },
            { label: 'Conversational Memory', slug: 'features/memory' },
            { label: 'Evolution System', slug: 'features/evolution' },
            { label: 'Relationships', slug: 'features/relationships' },
            { label: 'Safety Gates', slug: 'features/safety-gates' },
            { label: 'Intent Alignment', slug: 'features/intent' },
            { label: 'Multi-Machine', slug: 'features/multi-machine' },
            { label: 'Serendipity Protocol', slug: 'features/serendipity' },
            { label: 'Threadline Protocol', slug: 'features/threadline' },
            { label: 'Agent Skills', slug: 'features/skills' },
            { label: 'Self-Healing', slug: 'features/self-healing' },
            { label: 'AutoUpdater', slug: 'features/autoupdater' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Under the Hood', slug: 'architecture/under-the-hood' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI Commands', slug: 'reference/cli' },
            { label: 'API Endpoints', slug: 'reference/api' },
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'File Structure', slug: 'reference/file-structure' },
            { label: 'Hooks', slug: 'reference/hooks' },
            { label: 'Default Jobs', slug: 'reference/default-jobs' },
            { label: 'Threadline Protocol', slug: 'reference/threadline-protocol' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Agent Communication', slug: 'guides/agent-communication' },
            { label: 'Security Model', slug: 'guides/security' },
            { label: 'vs OpenClaw', slug: 'guides/vs-openclaw' },
          ],
        },
      ],
    }),
  ],

  adapter: vercel()
});
