"""Celery autoload: `autodiscover_tasks(['tasks'])` imports `tasks.tasks`."""

from . import beat_prompt_task  # noqa: F401
from . import evaluation_task  # noqa: F401
from . import image_task  # noqa: F401
from . import reference_image_task  # noqa: F401
from . import story_task  # noqa: F401
from . import storyboard_task  # noqa: F401
from . import transition_task  # noqa: F401
from . import video_task  # noqa: F401
