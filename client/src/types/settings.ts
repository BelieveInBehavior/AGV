export interface AiSettings {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeySet: boolean;
  imageProvider: 'fal' | 'none' | 'gemini' | 'doubao';
  imageModel: string;
  imageApiKeySet: boolean;
  imageSupportsMultiReference: boolean;
  imageMaxReferenceImages: number;
  videoBaseUrl: string;
  videoModel: string;
  videoApiKeySet: boolean;
}
