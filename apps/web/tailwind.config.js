/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
    '../../packages/config/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Primary: signal orange/red - urgent, high-energy, white text safe (AA)
        brand: {
          50: '#fff5f0',
          100: '#ffe8dd',
          200: '#ffd6c2',
          300: '#ffb189',
          400: '#ff8a5b',
          500: '#ff6733',
          600: '#d93809',
          700: '#b22c07',
          800: '#8c2406',
          900: '#6e1e07',
          950: '#3f0f03',
        },
        // Accent: sunny yellow - used on dark/ink backgrounds, chips, highlights
        sun: {
          50: '#fffbe6',
          100: '#fff6c2',
          200: '#ffe98a',
          300: '#ffdd4d',
          400: '#ffd100',
          500: '#f2be00',
          600: '#d9a400',
          700: '#b08200',
          800: '#8a6600',
          900: '#6e5100',
        },
        // Warm canvas + ink for that app-like, high-contrast feel
        canvas: '#fbfaf7',
        ink: '#14161c',
      },
      boxShadow: {
        card: '0 1px 2px rgba(20, 22, 28, 0.04), 0 8px 24px -12px rgba(20, 22, 28, 0.18)',
        pop: '0 2px 0 rgba(20, 22, 28, 0.9), 0 12px 32px -12px rgba(217, 56, 9, 0.45)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.4s ease-out both',
        'pop-in': 'pop-in 0.25s ease-out both',
        marquee: 'marquee 28s linear infinite',
      },
    },
  },
  plugins: [],
};
