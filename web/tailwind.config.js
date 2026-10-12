/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Noto Sans', 'Noto Sans Devanagari', 'sans-serif'],
      },
      colors: {
        // Colour carries meaning here, and only here: it is the attendance status.
        present: { DEFAULT: '#15803d', soft: '#dcfce7', line: '#86efac' },
        review: { DEFAULT: '#b45309', soft: '#fef3c7', line: '#fcd34d' },
        blocked: { DEFAULT: '#b91c1c', soft: '#fee2e2', line: '#fca5a5' },
        manual: { DEFAULT: '#0369a1', soft: '#e0f2fe', line: '#7dd3fc' },
      },
      borderRadius: { DEFAULT: '6px', lg: '8px', xl: '8px' },
    },
  },
  plugins: [],
};
