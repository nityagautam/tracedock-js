@ui
Feature: Wikipedia UI evidence

  @p1
  Scenario: Read the Wikipedia article
    Given I open the Wikipedia article
    Then the article heading should be "Wikipedia"
    And the article should describe a free encyclopedia

  @intentional-failure
  Scenario: Demonstrate a failed UI assertion
    Given I open the Wikipedia article
    # Intentionally wrong to retain a screenshot, video and trace.
    Then the article heading should be "TraceOptix intentionally incorrect heading"
    And the article should describe a free encyclopedia
