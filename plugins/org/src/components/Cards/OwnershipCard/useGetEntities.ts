/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Entity,
  parseEntityRef,
  RELATION_MEMBER_OF,
  RELATION_PARENT_OF,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import {
  CatalogApi,
  catalogApiRef,
  getEntityRelations,
  humanizeEntityRef,
} from '@backstage/plugin-catalog-react';
import limiterFactory from 'p-limit';
import { useApi } from '@backstage/core-plugin-api';
import useAsync from 'react-use/lib/useAsync';
import qs from 'qs';
import { EntityRelationAggregation } from '../types';
import { uniq } from 'lodash';

const limiter = limiterFactory(10);

type EntityTypeProps = {
  kind: string;
  type?: string;
  count: number;
};

const getQueryParams = (
  ownersEntityRef: string[],
  selectedEntity: EntityTypeProps,
): string => {
  const { kind, type } = selectedEntity;
  const owners = ownersEntityRef.map(owner =>
    humanizeEntityRef(parseEntityRef(owner), { defaultKind: 'group' }),
  );
  const filters = {
    kind: kind.toLocaleLowerCase('en-US'),
    type,
    owners,
    user: 'all',
  };
  return qs.stringify({ filters }, { arrayFormat: 'repeat' });
};

const getMemberOfEntityRefs = (owner: Entity): string[] => {
  const parentGroups = getEntityRelations(owner, RELATION_MEMBER_OF, {
    kind: 'Group',
  });

  const ownerGroupsNames = parentGroups.map(({ kind, namespace, name }) =>
    stringifyEntityRef({
      kind,
      namespace,
      name,
    }),
  );

  return [...ownerGroupsNames, stringifyEntityRef(owner)];
};

const isEntity = (entity: Entity | undefined): entity is Entity =>
  entity !== undefined;

const getChildOwnershipEntityRefs = async (
  entity: Entity,
  catalogApi: CatalogApi,
  alreadyRetrievedParentRefs: string[] = [],
): Promise<string[]> => {
  const childGroups = getEntityRelations(entity, RELATION_PARENT_OF, {
    kind: 'Group',
  });

  const hasChildGroups = childGroups.length > 0;

  const entityRef = stringifyEntityRef(entity);
  if (hasChildGroups) {
    const entityRefs = childGroups.map(r => stringifyEntityRef(r));
    const childGroupResponse = await catalogApi.getEntitiesByRefs({
      fields: ['kind', 'metadata.namespace', 'metadata.name', 'relations'],
      entityRefs,
    });
    const childGroupEntities = childGroupResponse.items.filter(isEntity);

    const unknownChildren = childGroupEntities.filter(
      childGroupEntity =>
        !alreadyRetrievedParentRefs.includes(
          stringifyEntityRef(childGroupEntity),
        ),
    );
    const childrenRefs = (
      await Promise.all(
        unknownChildren.map(childGroupEntity =>
          limiter(() =>
            getChildOwnershipEntityRefs(childGroupEntity, catalogApi, [
              ...alreadyRetrievedParentRefs,
              entityRef,
            ]),
          ),
        ),
      )
    ).flatMap(aggregated => aggregated);

    return uniq([...childrenRefs, entityRef]);
  }

  return [entityRef];
};

const getOwners = async (
  entity: Entity,
  relations: EntityRelationAggregation,
  catalogApi: CatalogApi,
): Promise<string[]> => {
  const isGroup = entity.kind === 'Group';
  const isAggregated = relations === 'aggregated';
  const isUserEntity = entity.kind === 'User';

  if (isAggregated && isGroup) {
    return getChildOwnershipEntityRefs(entity, catalogApi);
  }

  if (isAggregated && isUserEntity) {
    return getMemberOfEntityRefs(entity);
  }

  return [stringifyEntityRef(entity)];
};

const getOwnedEntitiesByOwners = (
  owners: string[],
  kinds: string[],
  catalogApi: CatalogApi,
) =>
  catalogApi.getEntities({
    filter: [
      {
        kind: kinds,
        'relations.ownedBy': owners,
      },
    ],
    fields: [
      'kind',
      'metadata.name',
      'metadata.namespace',
      'spec.type',
      'relations',
    ],
  });

export function useGetEntities(
  entity: Entity,
  relations: EntityRelationAggregation,
  entityFilterKind?: string[],
  entityLimit = 6,
): {
  componentsWithCounters:
    | {
        counter: number;
        type: string;
        kind: string;
        queryParams: string;
      }[]
    | undefined;
  loading: boolean;
  error?: Error;
} {
  const catalogApi = useApi(catalogApiRef);
  const kinds = entityFilterKind ?? ['Component', 'API', 'System'];

  const {
    loading,
    error,
    value: componentsWithCounters,
  } = useAsync(async () => {
    const owners = await getOwners(entity, relations, catalogApi);

    const ownedEntitiesList = await getOwnedEntitiesByOwners(
      owners,
      kinds,
      catalogApi,
    );

    const counts = ownedEntitiesList.items.reduce(
      (acc: EntityTypeProps[], ownedEntity) => {
        const match = acc.find(
          x => x.kind === ownedEntity.kind && x.type === ownedEntity.spec?.type,
        );
        if (match) {
          match.count += 1;
        } else {
          acc.push({
            kind: ownedEntity.kind,
            type: ownedEntity.spec?.type?.toString(),
            count: 1,
          });
        }
        return acc;
      },
      [],
    );

    // Return top N (entityLimit) entities to be displayed in ownership boxes
    const topN = counts.sort((a, b) => b.count - a.count).slice(0, entityLimit);

    return topN.map(topOwnedEntity => ({
      counter: topOwnedEntity.count,
      type: topOwnedEntity.type,
      kind: topOwnedEntity.kind,
      queryParams: getQueryParams(owners, topOwnedEntity),
    })) as Array<{
      counter: number;
      type: string;
      kind: string;
      queryParams: string;
    }>;
  }, [catalogApi, entity, relations]);

  return {
    componentsWithCounters,
    loading,
    error,
  };
}
