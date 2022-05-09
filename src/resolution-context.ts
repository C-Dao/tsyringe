import {Registration} from "./dependency-container";

/** resolve 调用上下文，供缓存 resolutionsScoped lifecycle 下生成的注入依赖实例 */
export default class ResolutionContext {
  scopedResolutions: Map<Registration, any> = new Map();
}
