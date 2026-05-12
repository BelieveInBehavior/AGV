export interface UserInfo {
  user_id?: string;
  phone: string;
  nickname: string;
}

export interface SendCodeResponse {
  success: boolean;
  message: string;
}

export interface VerifyCodeResponse {
  success: boolean;
  message: string;
  token?: string;
  expires_in?: number;
  user_info?: UserInfo;
}
