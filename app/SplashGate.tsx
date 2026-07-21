'use client';

import { useEffect, useState } from 'react';

export default function SplashGate({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(true);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadeOut(true), 1200);
    const removeTimer = setTimeout(() => setVisible(false), 1500);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, []);

  return (
    <>
      {visible && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            height: '100dvh',
            background: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            opacity: fadeOut ? 0 : 1,
            transition: 'opacity 0.3s ease',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <h1
              style={{
                fontSize: '22px',
                fontWeight: 600,
                color: '#222',
                textAlign: 'center',
                padding: '0 20px',
                margin: 0,
              }}
            >
              세계로병원 환자식 메뉴 안내
            </h1>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/loading.png"
              alt="세계로병원 환자식단표"
              style={{
                width: 'min(70vw, 320px)',
                height: 'auto',
                animation: 'splash-float 1.6s ease-in-out infinite',
              }}
            />
          </div>
          <style>{`
            @keyframes splash-float {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-8px); }
            }
          `}</style>
        </div>
      )}
      {children}
    </>
  );
}
