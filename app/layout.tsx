import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '期鉴 · 期货情报与策略平台',
  description: '黄金、白银、锡及全球期货市场的实时情报、变化追踪与七日策略。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
