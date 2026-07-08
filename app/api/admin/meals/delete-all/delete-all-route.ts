import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE_NAME, verifySessionToken } from "@/lib/adminAuth";
import { getAdminDb } from "@/lib/firebaseAdmin";

export async function POST(_req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!verifySessionToken(token)) {
    return NextResponse.json(
      { ok: false, message: "관리자 권한이 필요합니다." },
      { status: 401 }
    );
  }

  const db = getAdminDb();
  const collectionRef = db.collection("meals");

  let deleted = 0;
  const batchSize = 400;

  // Firestore에는 "컬렉션 통째로 삭제" API가 없어서, 문서를 배치 단위로 나눠 읽고 지웁니다.
  // 지워지면 그 자리에 남은 문서가 다시 채워지므로 매번 처음부터 limit(batchSize)로 읽어도 됩니다.
  while (true) {
    const snapshot = await collectionRef.limit(batchSize).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.size;

    if (snapshot.size < batchSize) break;
  }

  return NextResponse.json({ ok: true, deleted });
}
