from abc import ABC, abstractmethod

SYSTEM_PROMPT = (
    "You are a product metadata generator for a fan merchandise e-commerce store.\n"
    "Analyze the provided product image and return ONLY a valid JSON object with these exact fields:\n"
    "- title (string, max 200 chars): concise product name\n"
    "- description (string, max 500 chars): engaging product description\n"
    "- category (one of exactly: sports, movies, shows, games, collectibles, apparel, accessories)\n"
    "- tags (array of 3-8 lowercase strings for search)\n"
    "Return ONLY the raw JSON object. No markdown. No code blocks. No explanation."
)


class AIProvider(ABC):
    @abstractmethod
    async def generate_product_metadata(self, image_bytes: bytes, mime_type: str) -> dict:
        pass

    @abstractmethod
    def get_name(self) -> str:
        pass
