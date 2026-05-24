/** 角色形象参考图强制比例（与 API / Worker `CHARACTER_REFERENCE_RATIO` 一致） */
export const CHARACTER_REFERENCE_RATIO = '9:16' as const;

export const CHARACTER_REFERENCE_ASPECT = 9 / 16;

/** 上传时宽高比校验容差（相对 9/16） */
export const CHARACTER_REFERENCE_ASPECT_TOLERANCE = 0.08;

export function isCharacterReferenceAspectRatio(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return Math.abs(ratio - CHARACTER_REFERENCE_ASPECT) <= CHARACTER_REFERENCE_ASPECT_TOLERANCE;
}

export function readImageFileDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片尺寸'));
    };
    img.src = url;
  });
}
