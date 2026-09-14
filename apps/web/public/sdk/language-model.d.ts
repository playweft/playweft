export interface LanguageModelPromptOptions {
  maxOutputTokens?: number;
  signal?: AbortSignal;
}
export type LanguageModelInput = string | Array<{
  role: "system" | "user" | "assistant";
  content: string;
}>;
export function createLanguageModelClient(port: MessagePort): {
  prompt(input: LanguageModelInput, options?: LanguageModelPromptOptions): Promise<string>;
  destroy(): void;
};
