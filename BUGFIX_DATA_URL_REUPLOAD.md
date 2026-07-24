# Bug Fix: 首尾帧 Base64 Data URL 重复生成问题

## 问题描述

Task `task_f7083b526e76` 在生图时出现以下问题：

- **现象**：首帧已经存在 base64 data URL (`data:image/jpeg;base64,...`)，但系统仍在重新生成图片
- **根本原因**：系统检查 `imageUrl` 是否存在时，不区分 "已有真实URL" 和 "已有base64临时数据"
  - Base64 data URL 应被认为是 **临时状态**，需要上传到OSS转换为真实URL
  - 系统错误地将其视为已完成状态，跳过生成，但实际上还需要转换
  - 当定向请求生成时，系统再次生成图片（因为data URL不是真实URL）

## 根本原因

`worker/tasks/image_task.py` 中的 `_collect_beat_jobs()` 函数（第49行）：

```python
# 旧逻辑 - 错误
if not isinstance(fr, dict) or fr.get('imageUrl'):
    continue  # 任何有 imageUrl 的都跳过，包括 data URL
```

这导致：
1. 批量生成时：data URL 被跳过（不生成）
2. 定向生成时：data URL 被当做不存在，重新生成

## 解决方案

### 1. 区分 URL 类型

添加 `_is_data_url()` 函数检测 base64 data URL：

```python
def _is_data_url(url: str) -> bool:
    """检查是否为 base64 data URL"""
    return isinstance(url, str) and url.startswith('data:')
```

### 2. 修改任务收集逻辑

更新 `_collect_beat_jobs()` 和 `_build_targeted_beat_job()`：

- **跳过条件**：只跳过 "已有非 data URL 的图片"
- **包含条件**：包括 "无 imageUrl" 和 "有 data URL 需要上传" 的情况
- 添加 `has_data_url` 标记，用于区分是否需要上传

```python
image_url = fr.get('imageUrl')
# 跳过已有非 data URL 的图片
if image_url and not _is_data_url(image_url):
    continue
# 包括：1) 无 imageUrl，2) 有 data URL 需要上传
jobs.append({
    'kind': 'beat_v2',
    'clipId': clip['clipId'],
    'slot': slot,
    'frame': fr,
    'clip': clip,
    'has_data_url': _is_data_url(image_url),
})
```

### 3. 在生成任务中处理 data URL

在 `generate_images()` 的 beat_v2 处理段添加逻辑：

```python
# 如果已有 data URL，直接上传到 OSS，无需重新生成
if item.get('has_data_url'):
    existing_data_url = frame.get('imageUrl')
    if _is_data_url(existing_data_url):
        print(f'[INFO] Uploading existing data URL for {clip["clipId"]}:{slot}')
        try:
            from utils.reference_assets import upload_image_data_url_to_oss
            oss_result = upload_image_data_url_to_oss(existing_data_url, f'{slot}.jpg', 'clips')
            image_url = oss_result['url']
            # 更新 DB，标记为完成
            # 不走下面的生成逻辑，直接 continue
        except Exception as upload_err:
            print(f'[WARN] Failed to upload data URL: {upload_err}, will regenerate')
```

### 4. 新增 OSS 上传函数

在 `worker/utils/reference_assets.py` 中添加 `upload_image_data_url_to_oss()`：

```python
def upload_image_data_url_to_oss(data_url: str, file_name: str = '', sub_dir: str = 'uploads') -> dict:
    """将 base64 data URL 上传到 OSS。返回 {'url': oss_url, 'objectKey': key}"""
    # 1. 解析 data URL，提取 MIME type 和 base64 内容
    # 2. 解码 base64 为二进制
    # 3. 上传到 OSS
    # 4. 返回 OSS URL
```

## 修改文件

1. **worker/tasks/image_task.py**
   - 添加 `_is_data_url()` 函数
   - 修改 `_collect_beat_jobs()` 逻辑
   - 修改 `_build_targeted_beat_job()` 逻辑
   - 在 beat_v2 处理中添加 data URL 上传逻辑

2. **worker/utils/reference_assets.py**
   - 添加 `upload_image_data_url_to_oss()` 函数

## 预期行为修复

### 修复前
```
首尾帧有 base64 data URL
↓
批量生成任务：跳过（错误认为已完成）
↓
定向生成任务：重新生成（不认识 data URL）
↓
重复生成、浪费资源
```

### 修复后
```
首尾帧有 base64 data URL
↓
任务识别为需要上传的 data URL
↓
直接上传到 OSS，转换为真实 URL
↓
标记完成，不重新生成
↓
节省资源、逻辑一致
```

## 测试验证

在 task `task_f7083b526e76` 重新生成时：

1. 系统应该检测到 first_frame 有 data URL
2. 不重新生成，而是直接上传到 OSS
3. OSS URL 替换 data URL
4. 任务标记为完成

日志示例：
```
[INFO] Uploading existing data URL for clip_68b07b13296c:first_frame
[INFO] Successfully uploaded to OSS: https://bucket.endpoint/AGV/clips/1723052400000_abcd1234.jpg
```
