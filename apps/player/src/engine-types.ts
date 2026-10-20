/** 选项 C 生成上下文（生成在服务端完成，玩家端只传参） */
export interface GenCtx {
    prevText?: string;
    choiceText?: string;
    custom?: boolean;      // 选项 C 自由输入
    generated?: string;    // 服务端预生成好的文本
}
