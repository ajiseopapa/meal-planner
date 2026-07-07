import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "@/lib/adminAuth";
import { adminDb } from "@/lib/firebaseAdmin";

type MealUpdateInput = {
  key: string;
  date: string; // YYYY-MM-DD
  diet: string;
  mealType: string;
  category: string;
  value: string;
};

function isValidUpdate(u: unknown): u is MealUpdateInput {
  if (!u || typeof u !== "object") return false;
  const r = u as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.date === "string" &&
    typeof r.diet === "string" &&
    typeof r.mealType === "string" &&
    typeof r.category === "string" &&
    typeof r.value === "string"
  );
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  const isAdmin = verifySessionToken(token);

  if (!isAdmin) {
    return NextResponse.json(
      { ok: false, message: "관리자 권한이 필요합니다." },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => null);
  const updates = body?.updates;

  if (!Array.isArray(updates) || updates.length === 0 || !updates.every(isValidUpdate)) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  // Firestore 배치는 한 번에 최대 500개라 나눠서 처리
  const chunkSize = 400;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize) as MealUpdateInput[];
    const batch = adminDb.batch();
    for (const u of chunk) {
      const ref = adminDb.collection("meals").doc(u.key);
      if (u.value.trim() === "") {
        batch.delete(ref);
      } else {
        batch.set(ref, {
          date: u.date,
          diet: u.diet,
          mealType: u.mealType,
          category: u.category,
          value: u.value.trim(),
          updatedAt: new Date(),
        });
      }
    }
    await batch.commit();
  }

  return NextResponse.json({ ok: true, count: updates.length });
}
