from typing import Literal

from pydantic import BaseModel, Field


class ProductMetadata(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=2000)
    category: Literal["sports", "movies", "shows", "games", "collectibles", "apparel", "accessories"]
    tags: list[str] = Field(min_length=1, max_length=10)

    model_config = {"extra": "forbid"}


def validate_metadata(data: dict) -> tuple[bool, list[str] | None]:
    try:
        ProductMetadata.model_validate(data)
        return True, None
    except Exception as exc:
        return False, [str(exc)]
