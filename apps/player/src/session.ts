// 登录态与当前孩子（模块级共享，避免循环依赖）
// token / childId 持久化在 localStorage；email 仅内存展示
import type { ChildInfo } from "./api";

export const session = {
    token: localStorage.getItem("taka_token") || "",
    email: "",
    childId: Number(localStorage.getItem("taka_child_id")) || null as number | null,
    children: [] as ChildInfo[] // /api/auth/me 拉取后由 auth.ts 填充
};

/** 当前选中的孩子档案（未选中/未登录为 undefined） */
export function selectedChild(): ChildInfo | undefined {
    return session.children.find(c => c.id === session.childId);
}

export function setToken(token: string): void {
    session.token = token;
    localStorage.setItem("taka_token", token);
}

export function setChild(childId: number | null): void {
    session.childId = childId;
    if (childId) localStorage.setItem("taka_child_id", String(childId));
    else localStorage.removeItem("taka_child_id");
}

export function clearSession(): void {
    session.token = "";
    session.email = "";
    setChild(null);
    localStorage.removeItem("taka_token");
}
