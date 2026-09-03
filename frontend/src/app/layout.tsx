import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import ThemeToggle from "@/components/ThemeToggle";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tailored Resume Builder",
  description: "Build ATS-optimized resumes tailored to job descriptions using AI",
  icons: {
    icon: "/freebuilder-icon.svg",
    shortcut: "/freebuilder-icon.svg",
    apple: "/freebuilder-icon.svg",
  },
};

const themeInitScript = `
  (() => {
    const storageKey = 'tailor-theme';
    const defaultStorageKey = 'tailor-default-theme';
    const root = document.documentElement;
    const systemPrefersDark = () =>
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const applyTheme = (theme) => {
      root.classList.toggle('dark', theme === 'dark');
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    };

    try {
      const storedTheme = window.localStorage.getItem(storageKey);
      const storedDefaultTheme = window.localStorage.getItem(defaultStorageKey);
      const resolvedTheme =
        storedTheme === 'light' || storedTheme === 'dark'
          ? storedTheme
          : storedDefaultTheme === 'light' || storedDefaultTheme === 'dark'
            ? storedDefaultTheme
          : systemPrefersDark()
            ? 'dark'
            : 'light';

      applyTheme(resolvedTheme);
    } catch {
      applyTheme(systemPrefersDark() ? 'dark' : 'light');
    }
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <ThemeToggle />
      </body>
    </html>
  );
}
