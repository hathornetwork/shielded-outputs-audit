.PHONY: install build sync clear_cloudfront_cache deploy

install:
	npm install

build: install
	./scripts/deploy.sh $(site) build

sync:
	./scripts/deploy.sh $(site) sync

clear_cloudfront_cache:
	./scripts/deploy.sh $(site) clear_cache

deploy: build sync clear_cloudfront_cache
