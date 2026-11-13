import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#0F1B33", 800: "#16264A", 700: "#1E3160" },
        brand: { DEFAULT: "#2563EB", hover: "#1D4ED8", soft: "#EEF3FF", ring: "#93B4FA" },
        lime: { accent: "#D9F99D" },
        canvas: "#F3F5F9",
      },
      fontFamily: { sans: ["'Plus Jakarta Sans'", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
      borderRadius: { xl: "14px", "2xl": "20px" },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,.04), 0 4px 16px rgba(15,23,42,.04)",
        pop: "0 12px 40px rgba(15,23,42,.16)",
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "none" } },
        "scale-in": { from: { opacity: "0", transform: "scale(.97)" }, to: { opacity: "1", transform: "none" } },
        "slide-in": { from: { transform: "translateX(-100%)" }, to: { transform: "none" } },
        "sheet-up": { from: { transform: "translateY(100%)" }, to: { transform: "none" } },
      },
      animation: {
        "fade-up": "fade-up .35s cubic-bezier(.22,1,.36,1) both",
        "scale-in": "scale-in .2s cubic-bezier(.22,1,.36,1) both",
        "slide-in": "slide-in .25s cubic-bezier(.22,1,.36,1) both",
        "sheet-up": "sheet-up .28s cubic-bezier(.22,1,.36,1) both",
      },
    },
  },
  plugins: [],
} satisfies Config;
