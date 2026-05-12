"""Celery autoload: `autodiscover_tasks(['tasks'])` imports `tasks.tasks`."""

from . import image_task  # noqa: F401
from . import story_task  # noqa: F401
from . import storyboard_task  # noqa: F401
