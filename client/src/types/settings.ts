export interface AiSettings {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeySet: boolean;
  imageProvider: 'fal' | 'none';
  imageModel: string;
  imageApiKeySet: boolean;
  videoBaseUrl: string;
  videoModel: string;
  videoApiKeySet: boolean;
}
