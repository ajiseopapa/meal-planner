import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "@/lib/adminAuth";
import { getAdminDb } from "@/lib/firebaseAdmin";

// 식단 종류별 영양 목표(상한)를 저장합니다.
// 별도 컬렉션을 새로 만들지 않고, 이미 읽기 규칙이 열려 있는 customAllergens 컬렉션의
// "nutritionTargets" 문서에 { targets: { "당뇨식": { kcal, protein, sodium }, ... } } 형태로
// 통째로 저장합니다. (allergens 라우트와 동일하게 클라이언트가 전체 객체를 계산해서 덮어씀)
const CAPS = { kcal: 10000, protein: 1000, sodium: 100000 };
const MAX_DIETS = 20;
const MAX_DIET_LABEL = 20;

type DietTarget = { kcal?: number; protein?: number; sodium?: number };
type Targets = Record<string, DietTarget>;

function sanitizeNum(v: unknown, cap: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return Math.min(v, cap);
}

function sanitizeTargets(v: unknown): Targets | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_DIETS) return null;

  const out: Targets = {};
  for (const [diet, raw] of entries) {
    if (typeof diet !== "string" || diet.trim().length === 0 || diet.length > MAX_DIET_LABEL) {
      return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const obj: DietTarget = {};
    const kcal = sanitizeNum(r.kcal, CAPS.kcal);
    const protein = sanitizeNum(r.protein, CAPS.protein);
    const sodium = sanitizeNum(r.sodium, CAPS.sodium);
    if (kcal !== undefined) obj.kcal = kcal;
    if (protein !== undefined) obj.protein = protein;
    if (sodium !== undefined) obj.sodium = sodium;
    // 값이 하나라도 있는 식단만 저장 (빈 목표는 제외)
    if (Object.keys(obj).length > 0) out[diet.trim()] = obj;
  }
  return out;
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
  const targets = sanitizeTargets(body?.targets);

  if (targets === null) {
    return NextResponse.json(
      { ok: false, message: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const adminDb = getAdminDb();
  await adminDb.collection("customAllergens").doc("nutritionTargets").set({
    targets,
    updatedAt: new Date(),
  });

  return NextResponse.json({ ok: true, count: Object.keys(targets).length });
}
