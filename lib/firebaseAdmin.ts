import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function getAdminApp(): App {
  const existing = getApps();
  if (existing.length > 0) return existing[0]!;

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      ".env.local에 FIREBASE_ADMIN_PROJECT_ID / FIREBASE_ADMIN_CLIENT_EMAIL / " +
        "FIREBASE_ADMIN_PRIVATE_KEY 중 누락된 값이 있습니다."
    );
  }

  // .env 파일에 "\n"이 문자 그대로(백슬래시+n) 저장된 경우 실제 개행으로 변환.
  // 이미 실제 개행이 들어있는 경우엔 이 치환이 아무 영향도 주지 않으므로 안전함.
  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

export function getAdminDb() {
  return getFirestore(getAdminApp());
}
