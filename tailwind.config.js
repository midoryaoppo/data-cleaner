/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.{html,js}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#effaf7',
          100: '#d8f3ec',
          200: '#b3e8dc',
          300: '#7fd8c6',
          400: '#43bfa9',
          500: '#20a48f',
          600: '#128475',
          700: '#10685e',
          800: '#10534d',
          900: '#0f4540',
          950: '#032b28',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Cascadia Code',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(15, 23, 42, 0.04), 0 24px 48px -24px rgba(15, 23, 42, 0.18)',
        lift: '0 2px 4px rgba(15, 23, 42, 0.04), 0 18px 40px -20px rgba(15, 23, 42, 0.28)',
      },
      letterSpacing: {
        tightest: '-0.045em',
      },
    },
  },
  plugins: [],
};
