import type { Config } from 'tailwindcss';

/**
 * HealthCloud design tokens.
 *
 * Surfaces are warm paper, never pure grey-white: this screen is looked at for
 * eight hours a day under fluorescent light, and cold white on a large monitor
 * is genuinely tiring. Shadows are warm-tinted for the same reason — a grey
 * shadow on a warm surface reads as dirt.
 *
 * The accent is a clinical teal rather than the usual healthcare blue. Blue is
 * so common in Indian HIS products that it carries no signal; teal reads
 * medical without looking like the thing the clinic is replacing.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#EFECE6',
        'bg-soft': '#F6F4F0',
        card: '#FFFFFF',
        dark: '#16181C',

        ink: {
          DEFAULT: '#16181C',
          60: '#54514B',
          40: '#6B6660',
          20: '#9A948C',
        },

        clinical: {
          DEFAULT: '#0F766E',
          soft: '#D6EDE9',
          tint: '#EEF7F5',
          text: '#0A5A54',
          deep: '#0B4F49',
        },

        coral: {
          DEFAULT: '#E4674F',
          soft: '#F8C9BE',
          text: '#B23A22',
        },

        amber: {
          DEFAULT: '#E8B23C',
          soft: '#FBEBC4',
          text: '#9A6C00',
        },

        green: {
          DEFAULT: '#2E7245',
          soft: '#DCEFE1',
          text: '#1F5531',
        },
      },

      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },

      borderRadius: {
        pill: '100px',
        tiny: '9px',
        panel: '14px',
        card: '20px',
        'card-lg': '28px',
      },

      boxShadow: {
        sm: '0 1px 2px rgba(60, 50, 35, 0.06), 0 2px 8px rgba(60, 50, 35, 0.05)',
        DEFAULT: '0 4px 14px rgba(60, 50, 35, 0.09), 0 2px 6px rgba(60, 50, 35, 0.05)',
        lg: '0 12px 34px rgba(60, 50, 35, 0.14), 0 4px 12px rgba(60, 50, 35, 0.07)',
        rail: '10px 0 24px rgba(60, 50, 35, 0.05)',
      },

      letterSpacing: {
        display: '-0.018em',
        label: '0.1em',
      },

      /**
       * Tailwind's default opacity scale jumps 10 → 20, which is too coarse for
       * hairline borders and tints on a warm surface: ink/10 is a visible line,
       * ink/20 is a heavy one, and most dividers want something in between.
       * These fill the gaps actually used in the UI.
       */
      opacity: {
        6: '0.06',
        8: '0.08',
        12: '0.12',
        15: '0.15',
        45: '0.45',
        55: '0.55',
        65: '0.65',
        85: '0.85',
      },
    },
  },
  plugins: [],
} satisfies Config;
