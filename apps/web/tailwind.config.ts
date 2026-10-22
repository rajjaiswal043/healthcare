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

        /**
         * Finished — a visit that is over, a patient who has left.
         *
         * Its own hue because GREEN ALREADY MEANS MONEY HERE: a paid bill, a
         * settled fee, "nothing outstanding". Using it for a completed visit
         * overloaded it, and on the day board the two landed on the same row —
         * where it also sat beside `clinical`, which is itself a teal-green, so
         * "finished" and "with the doctor" were two greens a metre from a
         * doctor's eyes.
         *
         * Muted to sit with the rest of the palette rather than the saturated
         * indigo of every framework default. Named for the flower, not the
         * colour, because every plain colour name is taken by Tailwind's own
         * scale and overriding one breaks it everywhere else.
         */
        iris: {
          DEFAULT: '#5B5EA6',
          soft: '#E3E4F3',
          text: '#3F4280',
        },

        /**
         * Out of the room — away at a machine, in another department.
         *
         * The day board used to tint this stage with plain grey, which is what
         * every disabled thing in the console is tinted with: "at the X-ray"
         * read as "switched off". It is a live, normal stage of a visit and it
         * deserves a colour of its own.
         *
         * A cool blue, as far from `clinical`'s teal as the palette allows
         * while staying in the same muted family — "in the room" and "out at a
         * machine" are the two stages a doctor most needs to tell apart, and
         * they sit next to each other on the board.
         */
        sky: {
          DEFAULT: '#3E6FA8',
          soft: '#DCE8F5',
          text: '#2A5180',
        },

        /**
         * Back from tests, holding a film, waiting to be seen again.
         *
         * Warmer and deeper than `amber`, and deliberately adjacent to it:
         * both are people waiting on a doctor, so they belong to the same
         * family — but this one has already waited once and is the more
         * urgent, so it is the stronger of the pair.
         *
         * Not `coral`. Coral means money owed or something wrong, and a
         * patient whose film came back is neither.
         */
        peach: {
          DEFAULT: '#D97A45',
          soft: '#FAE0CE',
          text: '#A1512A',
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
