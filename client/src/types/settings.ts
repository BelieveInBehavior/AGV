export interface AiSettings {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeySet: boolean;
  imageProvider: 'openai' | 'fal' | 'none' | 'gemini' | 'doubao';
  imageBaseUrl: string;
  imageModel: string;
  imageApiKeySet: boolean;
  imageSupportsMultiReference: boolean;
  imageMaxReferenceImages: number;
  videoBaseUrl: string;
  videoModel: string;
  videoApiKeySet: boolean;
}
