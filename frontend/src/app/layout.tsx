import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AppShell from "@/components/shell/AppShell";
import AuthGate from "@/components/auth/AuthGate";
import { AuthProvider } from "@/contexts/AuthContext";
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
  title: "Tailor",
  description: "Build ATS-optimized resumes tailored to job descriptions using AI",
  icons: {
    icon: "/tailor-icon.svg",
    shortcut: "/tailor-icon.svg",
    apple: "/tailor-icon.svg",
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
        {/*
          suppressHydrationWarning is load-bearing, not decorative. React
          hydrates <head> children by position, and a browser extension's
          content script runs before hydration and inserts its own
          <script src="chrome-extension://..."> at the top of <head>. Every
          later child shifts by one, and React then compares this element
          against the extension's script and reports a mismatch. The other
          tags here are hoistable, so React matches them by content and only
          this inline script is affected. Verified both ways in a headless
          Chromium: without the extension there is no warning at all; with one
          injected there is, and this attribute removes it.
        */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/*
          Wrapped here rather than in each layout, so a page added later is
          behind the gate by default.

          AppShell sits INSIDE the gate: it is the signed-in chrome, and
          AuthGate returns early for all three signed-out states, so the shell
          is never constructed without an account. The theme toggle used to
          hang off the end of this tree as a floating pill precisely so the
          sign-in screen would honour the theme; it now lives in the top bar,
          and AuthGate renders its own copy on the screens that have no bar.
        */}
        <AuthProvider>
          <AuthGate>
            <AppShell>{children}</AppShell>
          </AuthGate>
        </AuthProvider>
      </body>
    </html>
  );
}
